import { z } from "zod";
import type { Connection } from "./Connection";
import type { TypedError } from "./TypedError";

export enum MCP_RESPONSE_FORMAT {
  JSON = "json",
  MARKDOWN = "markdown",
}

export enum HTTP_METHOD {
  GET = "GET",
  POST = "POST",
  PUT = "PUT",
  DELETE = "DELETE",
  PATCH = "PATCH",
  OPTIONS = "OPTIONS",
}

export const DEFAULT_QUEUE = "default";

export type OAuthActionResponse = {
  user: { id: number };
};

export type McpActionConfig = {
  /** Expose this action as an MCP tool (default true) */
  tool?: boolean;
  /** Tag as the OAuth login action */
  isLoginAction?: boolean;
  /** Tag as the OAuth signup action */
  isSignupAction?: boolean;
  /**
   * Register this action as an MCP resource.
   * The action's `run()` must return `{ text: string; mimeType?: string }` or `{ blob: string; mimeType?: string }` (base64).
   * URI template variables (e.g., `{userId}` in `keryx://users/{userId}`) are passed as action params.
   */
  resource?: {
    /** Static URI, e.g. `"keryx://status"`. Mutually exclusive with `uriTemplate`. */
    uri?: string;
    /** URI template (RFC 6570), e.g. `"keryx://users/{userId}"`. Variables become action params. */
    uriTemplate?: string;
    /** MIME type of the resource content (e.g., `"application/json"`, `"text/plain"`) */
    mimeType?: string;
  };
  /**
   * Register this action as an MCP prompt.
   * The action's `inputs` schema becomes the prompt's argument schema.
   * The action's `run()` must return `{ description?: string; messages: PromptMessage[] }`.
   */
  prompt?: {
    /** Human-readable display title for the prompt */
    title?: string;
  };
  /**
   * Response format for MCP tool calls.
   * `MCP_RESPONSE_FORMAT.JSON` (default) returns `JSON.stringify(response)`.
   * `MCP_RESPONSE_FORMAT.MARKDOWN` returns a human-readable markdown rendering via `toMarkdown()`.
   */
  responseFormat?: MCP_RESPONSE_FORMAT;
};

export type ActionConstructorInputs = {
  /** Unique action name (also used for default routes, etc.) */
  name: string;

  /** Human-friendly description (defaults to `An Action: ${name}`) */
  description?: string;

  /** Zod schema used to validate/coerce inputs (and for type inference) */
  inputs?: z.ZodType<any>;

  /** Middleware hooks to run before/after `run()` */
  middleware?: ActionMiddleware[];

  /** Expose this action via the MCP server (defaults to `{ tool: true }`) */
  mcp?: McpActionConfig;

  /** Expose this action via HTTP (defaults: route `/${name}`, method `GET`) */
  web?: {
    /** HTTP route pattern (string with `:params` or a `RegExp`) */
    route?: RegExp | string;
    /** HTTP method to bind the route to */
    method?: HTTP_METHOD;
    /** When true, Swagger documents this endpoint as returning `text/event-stream` instead of JSON */
    streaming?: boolean;
  };

  /** Per-action timeout in ms (overrides global `config.actions.timeout`; 0 disables) */
  timeout?: number;

  /** Configure this action as a background task/job */
  task?: {
    /** Optional recurring frequency in milliseconds */
    frequency?: number;
    /** Queue name to enqueue jobs onto (defaults to `"default"`) */
    queue: string;
  };
};

export type ActionMiddlewareResponse = {
  updatedParams?: ActionParams<Action>;
  updatedResponse?: any;
};

/**
 * Middleware hooks that run before and/or after an action's `run()` method.
 * Middleware can mutate params (via `updatedParams`) or replace the response (via `updatedResponse`).
 */
export type ActionMiddleware = {
  /**
   * Runs before the action's `run()` method. Can modify params by returning `{ updatedParams }`.
   * Throw a `TypedError` to abort the action (e.g., for auth checks).
   */
  runBefore?: (
    params: ActionParams<Action>,
    connection: Connection,
  ) => Promise<ActionMiddlewareResponse | void>;
  /**
   * Runs after the action's `run()` method (in a `finally` block, so it always runs).
   * Can replace the response by returning `{ updatedResponse }`.
   *
   * @param params - The validated action inputs (same object passed to `run()`).
   * @param connection - The connection that initiated this action.
   * @param error - The `TypedError` from the action's `run()`, or `undefined` on success.
   *   Useful for middleware that needs to react to success/failure (e.g., committing or
   *   rolling back a database transaction).
   */
  runAfter?: (
    params: ActionParams<Action>,
    connection: Connection,
    error?: TypedError,
  ) => Promise<ActionMiddlewareResponse | void>;
};

/**
 * Abstract base class for transport-agnostic controllers. Actions serve simultaneously as
 * HTTP endpoints, WebSocket handlers, CLI commands, background tasks, and MCP tools.
 * Subclasses must implement the `run()` method.
 */
export abstract class Action {
  name: string;
  description?: string;
  inputs?: z.ZodType<any>;
  middleware?: ActionMiddleware[];
  mcp?: McpActionConfig;
  web?: {
    route: RegExp | string;
    method: HTTP_METHOD;
    streaming?: boolean;
  };
  timeout?: number;
  task?: {
    frequency?: number;
    queue: string;
  };
  constructor(args: ActionConstructorInputs) {
    this.name = args.name;
    this.description = args.description ?? `An Action: ${this.name}`;
    this.inputs = args.inputs;
    this.middleware = args.middleware ?? [];
    this.timeout = args.timeout;
    this.mcp = { tool: true, ...args.mcp };
    this.web = {
      route: args.web?.route ?? `/${this.name}`,
      method: args.web?.method ?? HTTP_METHOD.GET,
      streaming: args.web?.streaming ?? false,
    };
    this.task = {
      frequency: args.task?.frequency,
      queue: args.task?.queue ?? DEFAULT_QUEUE,
    };
  }

  /**
   * The main "do something" method for this action.
   * It can be `async`.
   * Usually the goal of this run method is to return the data that you want to be sent to API consumers.
   * If error is thrown in this method, it will be logged, caught, and returned to the client as `error`
   *
   * @param params - The validated and coerced action inputs. The type is inferred from the
   *   action's `inputs` Zod schema (falls back to `Record<string, unknown>` when no schema is
   *   defined). By the time `run` is called, all middleware `runBefore` hooks have already
   *   executed and may have mutated the params.
   * @param connection - The connection that initiated this action. Provides access to the
   *   caller's session (`connection.session`), subscription state, and raw transport handle.
   *   It is `undefined` when the action is invoked outside an HTTP/WebSocket request context
   *   (e.g., as a background task via the Resque worker or via `api.actions.run()`).
   * @param abortSignal - An `AbortSignal` tied to the action's timeout. The signal is aborted
   *   when the per-action `timeout` (or the global `config.actions.timeout`, default 300 000 ms)
   *   elapses. Long-running actions should check `abortSignal.aborted` or pass the signal to
   *   cancellable APIs (e.g., `fetch`) to exit promptly. Not provided when timeouts are
   *   disabled (`timeout: 0`).
   * @throws {TypedError} All errors thrown should be TypedError instances
   */
  abstract run(
    params: ActionParams<Action>,
    connection?: Connection,
    abortSignal?: AbortSignal,
  ): Promise<any>;
}

/**
 * Infers the validated input type for an action from its `inputs` Zod schema.
 * Falls back to `Record<string, unknown>` when no schema is defined.
 */
export type ActionParams<A extends Action> =
  A["inputs"] extends z.ZodType<any>
    ? z.infer<A["inputs"]>
    : Record<string, unknown>;

/**
 * Infers the return type of an action's `run()` method, merged with an optional `error` field.
 * Useful for typing API responses on the client side.
 */
export type ActionResponse<A extends Action> = Awaited<ReturnType<A["run"]>> &
  Partial<{ error?: TypedError }>;
