import { z } from "zod";
import type { Connection } from "./Connection";
import type { TypedError } from "./TypedError";

export enum MCP_RESPONSE_FORMAT {
  JSON = "json",
  MARKDOWN = "markdown",
}

/**
 * MIME type for MCP App UI resources, per the MCP Apps extension.
 * A `ui://` resource declared via an action's `mcp.ui` config is served with this type.
 * @see {@link https://modelcontextprotocol.io/extensions/apps/overview}
 */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Configures an action as an **MCP App** — a tool whose result renders an interactive
 * HTML UI in the host (Claude, Claude Desktop, VS Code Copilot, …) inside a sandboxed iframe.
 *
 * When set, Keryx registers a `ui://` resource that serves `html`, links the action's tool
 * to it via the tool's `_meta.ui.resourceUri`, and — when `run()` returns a `UIResponse` —
 * delivers `structuredContent` to the app for rendering.
 *
 * @see {@link https://modelcontextprotocol.io/extensions/apps/overview}
 */
export type McpUiConfig = {
  /**
   * Browser entrypoint for the app UI. Keryx bundles it at boot (with Bun's browser
   * bundler) and inlines the result into {@link McpUiConfig.html} — or a default
   * self-contained shell — to produce the served HTML. Point it at a `.ts`/`.tsx`
   * file, e.g. `new URL("./app/status.ts", import.meta.url)`.
   *
   * Provide `client`, `html`, or both. With only `client`, Keryx wraps the bundle in a
   * default shell (a document containing a `<div id="root">`). With both, `html` is the
   * shell the bundle is inlined into. See {@link McpUiConfig.html}.
   */
  client?: string | URL;
  /**
   * Self-contained HTML for the app UI. Keep external assets minimal (or inline them) so the
   * default deny-by-default CSP applies.
   *
   * - **Without `client`:** served verbatim — you inline your own scripts/styles. To serve
   *   HTML from a file, read it yourself (e.g. `await Bun.file(path).text()`) and pass the string.
   * - **With `client`:** treated as the shell the bundled client is inlined into — at an empty
   *   `<script type="module"></script>`, else a placeholder comment (`MCP_APP_CLIENT`), else
   *   appended before `</body>`.
   *
   * At least one of `client` or `html` must be set.
   */
  html?: string;
  /** The `ui://` resource URI. Defaults to `ui://<tool-name>`. */
  resourceUri?: string;
  /** Content-Security-Policy allowances for external origins the app may reach. */
  csp?: {
    /** Origins the app may `connect` to (fetch/XHR/WebSocket). */
    connectDomains?: string[];
    /** Origins the app may load sub-resources (scripts, styles, images, fonts) from. */
    resourceDomains?: string[];
    /** Origins the app may embed in nested frames. */
    frameDomains?: string[];
    /** Origins allowed in the app's `<base href>`. */
    baseUriDomains?: string[];
  };
  /** Additional iframe capabilities the app requests (subject to host/user consent). */
  permissions?: {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
  };
  /** Hint that the host should render a border/frame around the app. */
  prefersBorder?: boolean;
  /** Logical domain grouping for the app (host-specific display/isolation hint). */
  domain?: string;
};

/**
 * The lifecycle states of an MCP task (MCP `2025-11-25`). `completed`, `failed`,
 * and `cancelled` are terminal: once a task reaches one it never changes again.
 */
export type McpTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * What an action's {@link McpTaskConfig.status} callback reports about a durable
 * task. Keryx stores it and answers `tasks/get` from it.
 */
export type McpTaskState = {
  /** The task's current status. A terminal status is final. */
  status: McpTaskStatus;
  /** Optional human-readable detail, surfaced to the client as `statusMessage`. */
  statusMessage?: string;
  /**
   * For a terminal status, the value `tasks/result` delivers. It is rendered
   * exactly like an action response (honoring `mcp.responseFormat`), and a
   * `failed` result is flagged `isError`. Defaults to the action's original
   * response when omitted.
   */
  result?: unknown;
};

/**
 * Publishes an MCP tool as **task-capable** (MCP Tasks, `2025-11-25`). A client
 * can then call the tool with `task: { ttl }`, get a task id back immediately,
 * and check on it later with `tasks/get`, `tasks/result`, `tasks/list`, and
 * `tasks/cancel` — from the same session or a later one, on any node.
 *
 * There are two kinds of task:
 *
 * - **Managed** (no `status`): Keryx runs the action in the background, and the
 *   task ends when `run()` does. Use it for an action that is merely slow.
 * - **Durable** (`status` set): `run()` starts work that lives in your own
 *   storage (a job row, a workflow execution) and returns a handle to it. The
 *   task stays `working` until `status(handle)` reports a terminal state, so it
 *   can outlive the request, the session, and the node that created it.
 *
 * @see {@link https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks}
 */
export type McpTaskConfig = {
  /**
   * `"optional"`: a plain `tools/call` still runs the action and returns its
   * response directly, exactly as without `task`; only a call that asks for a
   * task gets one. `"required"`: the tool may only be called as a task.
   */
  support: "optional" | "required";
  /**
   * Suggested interval (ms) between a client's `tasks/get` polls. Also how
   * often a blocked `tasks/result` re-checks. Defaults to
   * `config.server.mcp.taskPollInterval`.
   */
  pollInterval?: number;
  /**
   * Makes the task **durable**: report its state from your own storage. Called
   * on `tasks/get` (and while `tasks/result` waits) for as long as the task is
   * non-terminal, never after.
   *
   * @param response - What the action's `run()` returned when the task was
   *   created — the handle to your work.
   * @param connection - An MCP connection authenticated as the task's owner,
   *   so `connection.act(...)` runs the target action's middleware as that user.
   * @returns The task's current state. A thrown error is logged and the task
   *   keeps its last known state, so a transient failure doesn't end it.
   */
  status?: (
    response: any,
    connection: Connection,
  ) => Promise<McpTaskState> | McpTaskState;
  /**
   * Called on `tasks/cancel` for a non-terminal **durable** task, before it is
   * marked `cancelled`. Throw to refuse: the client gets an error and the task
   * keeps running. Without it, cancelling a durable task only stops tracking
   * it. A managed task's background run is never interrupted; its result is
   * discarded.
   *
   * @param response - What the action's `run()` returned when the task was created.
   * @param connection - An MCP connection authenticated as the task's owner.
   */
  cancel?: (response: any, connection: Connection) => Promise<void> | void;
};

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
  /**
   * Expose this action as an MCP tool. Tools are **opt-in** (default `false`):
   * set `tool: true` to publish the action to MCP clients. Declaring an MCP App
   * via `ui` implies a tool unless `tool` is explicitly `false`.
   */
  tool?: boolean;
  /**
   * Allow anonymous MCP clients to use this action. Only takes effect when the
   * server runs with `MCP_AUTH_MODE=optional`: a client without a bearer token
   * may then call this tool, read this resource or prompt, or load this MCP App
   * UI. Anonymous calls to non-public actions get a 401 challenge so the client
   * can authenticate. Has no effect in the default `required` mode, and never
   * changes HTTP/WebSocket access — that is still governed by `middleware`.
   */
  public?: boolean;
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
   * Register this action as an **MCP App** (a dynamic UI). The tool is linked to an
   * auto-registered `ui://` HTML resource, and the action's `run()` should return a
   * {@link UIResponse} to deliver structured data to the app.
   * @see {@link https://modelcontextprotocol.io/extensions/apps/overview}
   */
  ui?: McpUiConfig;
  /**
   * Response format for MCP tool calls.
   * `MCP_RESPONSE_FORMAT.JSON` (default) returns `JSON.stringify(response)`.
   * `MCP_RESPONSE_FORMAT.MARKDOWN` returns a human-readable markdown rendering via `toMarkdown()`.
   */
  responseFormat?: MCP_RESPONSE_FORMAT;
  /**
   * Make the tool task-capable (MCP Tasks), so a client can start it and check
   * on it later instead of holding one request open. See {@link McpTaskConfig}.
   */
  task?: McpTaskConfig;
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

  /** Expose this action via the MCP server. Tools are opt-in — set `mcp: { tool: true }` to publish one. */
  mcp?: McpActionConfig;

  /** Expose this action via HTTP (defaults: route `/${name}`, method `GET`) */
  web?: {
    /** HTTP route pattern (string with `:params` or a `RegExp`) */
    route?: RegExp | string;
    /** HTTP method to bind the route to */
    method?: HTTP_METHOD;
    /**
     * Declares this endpoint as a stream. Swagger documents it as returning
     * `text/event-stream` instead of JSON, and the web server passes the response body
     * through untouched — no compression, no idle timeout — so chunks reach the client as
     * they are produced. Returning a `StreamingResponse` gets that treatment on its own;
     * set this when the action hands back a raw `Response` wrapping a stream.
     */
    streaming?: boolean;
    /**
     * When true, the framework never reads the request body. `params` are built
     * from path and query params only, and the action reads the untouched body
     * itself via `connection.rawRequest` (`.text()`, `.arrayBuffer()`,
     * `.body` for a stream). Use this for proxies, webhook signature
     * verification, and binary uploads — anything that needs the bytes exactly
     * as sent, or needs to avoid buffering them twice.
     *
     * Because the body is never merged into `params`, a body key that collides
     * with a path param cannot override it.
     *
     * `config.server.web.maxBodySize` is still enforced against the
     * `Content-Length` header, but not while the action reads the stream — an
     * action consuming a chunked body owns that limit itself.
     */
    rawBody?: boolean;
  };

  /** Per-action timeout in ms (overrides global `config.actions.timeout`; 0 disables) */
  timeout?: number;

  /**
   * When `false`, tracing plugins (`@keryxjs/sentry`, `@keryxjs/tracing`) skip
   * this action: no action span, and for HTTP / background tasks the whole
   * request or job transaction is dropped. Error capture and metrics still
   * run. Unset (the default) means the action is traced.
   *
   * Use this for high-frequency health checks so they don't flood the trace
   * backend. The built-in `status` action sets `tracing = false`.
   */
  tracing?: boolean;

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
    rawBody?: boolean;
  };
  timeout?: number;
  /**
   * When `false`, tracing plugins skip this action. Unset means traced.
   * See {@link ActionConstructorInputs.tracing}.
   */
  tracing?: boolean;
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
    this.tracing = args.tracing;
    // MCP tools are opt-in — see the actions initializer for rationale. An action
    // becomes a tool only when it sets `mcp.tool = true` (or declares `mcp.ui`).
    this.mcp = { tool: false, ...args.mcp };
    this.web = {
      route: args.web?.route ?? `/${this.name}`,
      method: args.web?.method ?? HTTP_METHOD.GET,
      streaming: args.web?.streaming ?? false,
      rawBody: args.web?.rawBody ?? false,
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
   * @param connection - The connection that initiated this action. Always defined. Provides
   *   access to the caller's session (`connection.session`), subscription state, and raw
   *   transport handle. For background tasks (resque worker), `connection.type === "task"`
   *   and `connection.session.data` is empty — tasks are fresh starts, so actions that
   *   need user context should receive it as an input parameter rather than reading from
   *   the session.
   * @param abortSignal - An `AbortSignal` tied to the action's timeout. The signal is aborted
   *   when the per-action `timeout` (or the global `config.actions.timeout`, default 300 000 ms)
   *   elapses. Long-running actions should check `abortSignal.aborted` or pass the signal to
   *   cancellable APIs (e.g., `fetch`) to exit promptly. Not provided when timeouts are
   *   disabled (`timeout: 0`).
   * @throws {TypedError} All errors thrown should be TypedError instances
   */
  abstract run(
    params: ActionParams<Action>,
    connection: Connection,
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
