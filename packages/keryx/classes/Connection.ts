import { randomUUID } from "crypto";
import { api, logger } from "../api";
import { config } from "../config";
import type { PubSubMessage } from "../initializers/pubsub";
import type { SessionData } from "../initializers/session";
import type { RateLimitInfo } from "../middleware/rateLimit";
import { ansi } from "../util/ansi";
import { isSecret } from "../util/zodMixins";
import type { Action, ActionParams } from "./Action";
import { LogFormat } from "./Logger";
import { StreamingResponse } from "./StreamingResponse";
import { ErrorType, TypedError } from "./TypedError";

/**
 * Per-invocation context passed to {@link BeforeActHook} and {@link AfterActHook}.
 * The same object instance threads from `beforeAct` to `afterAct` for a single
 * action invocation, so hooks can stash span refs, timing data, etc.
 */
export interface ActContext {
  /** Mutable scratch space shared between `beforeAct` and `afterAct`. */
  metadata: Record<string, unknown>;
}

/**
 * Unified outcome passed to {@link AfterActHook}. Discriminate via the `success` field.
 * Covers both the happy-path and error paths of an action invocation.
 */
export type ActOutcome =
  | { success: true; response: unknown; duration: number }
  | { success: false; error: unknown; duration: number };

/**
 * Runs inside `Connection.act()` after params are validated and before the action's
 * own `runBefore` middleware. Fires for every action invocation regardless of
 * transport (web, websocket, task, cli, mcp, …) — inspect `connection.type` to
 * discriminate. Throwing fails the action.
 *
 * Register via `api.hooks.actions.beforeAct(...)`.
 */
export type BeforeActHook = (
  actionName: string,
  params: Record<string, unknown>,
  connection: Connection,
  ctx: ActContext,
) => Promise<void> | void;

/**
 * Runs inside `Connection.act()` after the action completes (success or failure),
 * in a `finally` block so it always fires if the corresponding `beforeAct` fired.
 * Receives the same `ctx` plus an {@link ActOutcome} describing what happened.
 *
 * Register via `api.hooks.actions.afterAct(...)`.
 */
export type AfterActHook = (
  actionName: string,
  params: Record<string, unknown>,
  connection: Connection,
  ctx: ActContext,
  outcome: ActOutcome,
) => Promise<void> | void;

type ActionParamsState = {
  value: Record<string, unknown>;
};

/**
 * The transport that originated a {@link Connection}. Use these constants
 * instead of bare strings when checking `connection.type` so the value is
 * consistent across the framework, plugins, and middleware.
 */
export enum CONNECTION_TYPE {
  /** HTTP request handled by the web server. */
  WEB = "web",
  /** WebSocket message handled by the web server's `Bun.serve` upgrade. */
  WEBSOCKET = "websocket",
  /** Action invoked from the CLI runner. */
  CLI = "cli",
  /** Action invoked through the MCP transport. */
  MCP = "mcp",
  /** Action running as a Resque background task. */
  TASK = "task",
  /** Action invoked from the OAuth login/signup flow. */
  OAUTH = "oauth",
}

/**
 * Represents a client connection to the server — HTTP request, WebSocket, or internal caller.
 * Each connection tracks its own session, channel subscriptions, and rate-limit state.
 *
 * @typeParam T - Shape of the session data stored in Redis (persists across requests).
 * @typeParam TMeta - Shape of request-scoped metadata that middleware and actions can
 *   read/write during a single `act()` call. Reset to `{}` at the start of each invocation.
 */
export class Connection<
  T extends Record<string, any> = Record<string, any>,
  TMeta extends Record<string, any> = Record<string, any>,
> {
  /** Transport that originated this connection. */
  type: CONNECTION_TYPE;
  /** A human-readable identifier for the connection, typically the remote IP or a session key. */
  identifier: string;
  /** Unique connection ID (UUID by default). Used as the key in `api.connections`. */
  id: string;
  /** Session ID used for Redis session lookup. Defaults to `id` but may differ for WebSocket connections where the session cookie differs from the connection map key. */
  sessionId: string;
  /** The connection's session data, lazily loaded on first action invocation. */
  session?: SessionData<T>;
  /** Set of channel names this connection is currently subscribed to. */
  subscriptions: Set<string>;
  /** Whether the session has been loaded from Redis at least once. */
  sessionLoaded: boolean;
  /** The underlying transport handle (e.g., Bun `ServerWebSocket`). */
  rawConnection?: any;
  /** Rate-limit metadata populated by the rate-limit middleware. */
  rateLimitInfo?: RateLimitInfo;
  /** Request correlation ID for distributed tracing. Propagated from the incoming `X-Request-Id` header when `config.server.web.correlationId.trustProxy` is enabled. */
  correlationId?: string;
  /** App-defined request-scoped metadata. Reset to `{}` at the start of each top-level `act()` call so that long-lived connections (e.g., WebSockets) don't leak state between actions. Preserved across nested `act()` calls so that middleware state (e.g., an open transaction) propagates to sub-actions. */
  metadata: Partial<TMeta>;
  /** @internal Tracks nested `act()` depth so metadata is only reset on the outermost call. */
  private _actDepth = 0;

  /**
   * Create a new connection and register it in `api.connections`.
   *
   * @param type - Transport that originated this connection.
   * @param identifier - Human-readable identifier, typically the remote IP address.
   * @param id - Unique connection ID. Defaults to a random UUID.
   * @param rawConnection - The underlying transport handle (e.g., Bun `ServerWebSocket`).
   * @param sessionId - Session ID for Redis session lookup. Defaults to `id`. Use a different value when the connection map key should differ from the session cookie (e.g., WebSocket connections).
   */
  constructor(
    type: CONNECTION_TYPE,
    identifier: string,
    id = randomUUID() as string,
    rawConnection: any = undefined,
    sessionId?: string,
  ) {
    this.type = type;
    this.identifier = identifier;
    this.id = id;
    this.sessionId = sessionId ?? id;
    this.sessionLoaded = false;
    this.subscriptions = new Set();
    this.rawConnection = rawConnection;
    this.metadata = {};

    api.connections.connections.set(this.id, this);
  }

  /**
   * Execute an action in the context of this connection. Handles the full lifecycle:
   * session loading, param validation via the action's Zod schema, middleware execution
   * (before/after), timeout enforcement, and structured logging.
   *
   * @param actionName - The name of the action to run. If not found, throws
   *   `ErrorType.CONNECTION_ACTION_NOT_FOUND`.
   * @param params - Raw parameters as a plain object. Validated and coerced
   *   against the action's `inputs` Zod schema.
   * @param method - The HTTP method of the incoming request (used for logging).
   * @param url - The request URL (used for logging).
   * @returns The action response and optional error.
   * @throws {TypedError} With the appropriate `ErrorType` for validation, timeout, or runtime failures.
   */
  async act(
    actionName: string | undefined,
    params: Record<string, unknown>,
    method: Request["method"] = "",
    url: string = "",
  ): Promise<{ response: Object; error?: TypedError }> {
    // Only reset metadata on the outermost act() call. Nested calls (action
    // chaining) preserve the parent's metadata so middleware state like an
    // open database transaction propagates to sub-actions.
    if (this._actDepth === 0) this.metadata = {};
    this._actDepth++;
    const reqStartTime = new Date().getTime();
    let loggerResponsePrefix: "OK" | "ERROR" = "OK";
    let response: Object = {};
    let error: TypedError | undefined;

    let action: Action | undefined;
    let formattedParams: Record<string, unknown> | undefined;
    let paramsState: ActionParamsState | undefined;
    const actCtx: ActContext = { metadata: {} };
    let beforeActRan = false;
    try {
      action = this.resolveAction(actionName);
      if (!this.sessionLoaded) await this.loadSession();
      formattedParams = await this.formatParams(params, action);
      paramsState = { value: formattedParams };
      await this.runBeforeActHooks(action, paramsState.value, actCtx);
      beforeActRan = true;
      await this.runMiddlewareBefore(action, paramsState);
      formattedParams = paramsState.value;
      response = await this.executeWithTimeout(action, formattedParams);
    } catch (e) {
      loggerResponsePrefix = "ERROR";
      error =
        e instanceof TypedError
          ? e
          : new TypedError({
              message: `${e}`,
              type: ErrorType.CONNECTION_ACTION_RUN,
              cause: e,
            });
    } finally {
      if (paramsState) formattedParams = paramsState.value;
      if (action && formattedParams)
        response = await this.runMiddlewareAfter(
          action,
          formattedParams,
          error,
          response,
        );
      if (beforeActRan && action && formattedParams) {
        await this.runAfterActHooks(
          action,
          formattedParams,
          actCtx,
          reqStartTime,
          response,
          error,
        );
      }
      this._actDepth--;
    }

    const duration = new Date().getTime() - reqStartTime;

    logAction({
      actionName,
      connectionType: this.type,
      status: loggerResponsePrefix,
      duration,
      params: sanitizeParams(params, action),
      method,
      url,
      identifier: this.identifier,
      correlationId: this.correlationId,
      error,
    });

    return { response, error };
  }

  /**
   * Merge new data into the connection's session. Loads the session first if not yet loaded.
   *
   * @param data - Partial session data to merge into the existing session.
   * @throws {TypedError} With `ErrorType.CONNECTION_SESSION_NOT_FOUND` if no session exists.
   */
  async updateSession(data: Partial<T>) {
    await this.loadSession();

    if (!this.session) {
      throw new TypedError({
        message: "Session not found",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }

    return api.session.update(this.session, data);
  }

  /**
   * Regenerate the session ID to prevent session fixation attacks.
   * Copies existing session data to a new key in Redis, deletes the old key,
   * and updates this connection's IDs so the response sets a fresh cookie.
   * Should be called after successful authentication.
   *
   * @returns The session data under the new ID.
   * @throws {TypedError} With `ErrorType.CONNECTION_SESSION_NOT_FOUND` if no session exists.
   */
  async regenerateSession() {
    await this.loadSession();

    if (!this.session) {
      throw new TypedError({
        message: "Session not found",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }

    return api.session.regenerate(this);
  }

  /** Add a channel to this connection's subscription set. */
  subscribe(channel: string) {
    this.subscriptions.add(channel);
  }

  /** Remove a channel from this connection's subscription set. */
  unsubscribe(channel: string) {
    this.subscriptions.delete(channel);
  }

  /**
   * Publish a message to a PubSub channel. The connection must already be subscribed.
   *
   * @param channel - The channel name to broadcast to.
   * @param message - The message payload to send.
   * @throws {TypedError} With `ErrorType.CONNECTION_NOT_SUBSCRIBED` if not subscribed.
   */
  async broadcast(channel: string, message: string) {
    if (!this.subscriptions.has(channel)) {
      throw new TypedError({
        message: "not subscribed to this channel",
        type: ErrorType.CONNECTION_NOT_SUBSCRIBED,
      });
    }

    return api.pubsub.broadcast(channel, message, this.id);
  }

  /**
   * Called when a PubSub message arrives for a channel this connection is subscribed to.
   * Must be overridden by transport-specific subclasses (e.g., WebSocket connections).
   *
   * @param _payload - The incoming PubSub message.
   * @throws {Error} Always throws in the base class — subclasses must override.
   */
  onBroadcastMessageReceived(_payload: PubSubMessage) {
    throw new Error(
      "unimplemented - this should be overwritten by connections that support it",
    );
  }

  /** Remove this connection from the global connections map and clean up resources. */
  destroy() {
    return api.connections.destroy(this.type, this.identifier, this.id);
  }

  /**
   * Load the session from Redis (or create a new one if none exists).
   * No-ops if the session is already loaded. Sets `sessionLoaded` to `true`.
   */
  async loadSession() {
    if (this.session) return;

    const session = await api.session.load(this);
    if (session) {
      this.session = session as SessionData<T>;
    } else {
      this.session = await api.session.create(this);
    }
    this.sessionLoaded = true;
  }

  private findAction(actionName: string | undefined) {
    return api.actions.actions.find((a: Action) => a.name === actionName);
  }

  private resolveAction(actionName: string | undefined) {
    const action = this.findAction(actionName);
    if (!action) {
      throw new TypedError({
        message: `Action not found${actionName ? `: ${actionName}` : ""}`,
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }

    return action;
  }

  private async runBeforeActHooks(
    action: Action,
    params: Record<string, unknown>,
    actCtx: ActContext,
  ) {
    for (const hook of api.hooks.actions.beforeActHooks) {
      await hook(action.name, params, this, actCtx);
    }
  }

  private async runAfterActHooks(
    action: Action,
    params: Record<string, unknown>,
    actCtx: ActContext,
    reqStartTime: number,
    response: Object,
    error: TypedError | undefined,
  ) {
    const actDuration = new Date().getTime() - reqStartTime;
    const outcome: ActOutcome = error
      ? { success: false, error, duration: actDuration }
      : { success: true, response, duration: actDuration };

    for (const hook of api.hooks.actions.afterActHooks) {
      await hook(action.name, params, this, actCtx, outcome);
    }
  }

  private async runMiddlewareBefore(
    action: Action,
    paramsState: ActionParamsState,
  ) {
    for (const middleware of action.middleware ?? []) {
      if (middleware.runBefore) {
        const middlewareResponse = await middleware.runBefore(
          paramsState.value,
          this,
        );
        if (middlewareResponse && middlewareResponse?.updatedParams)
          paramsState.value = middlewareResponse.updatedParams;
      }
    }
  }

  private async runMiddlewareAfter(
    action: Action,
    params: Record<string, unknown>,
    error: TypedError | undefined,
    response: Object,
  ) {
    let updatedResponse = response;
    for (const middleware of action.middleware ?? []) {
      if (middleware.runAfter) {
        const middlewareResponse = await middleware.runAfter(
          params,
          this,
          error,
        );
        if (middlewareResponse && middlewareResponse?.updatedResponse) {
          if (updatedResponse instanceof StreamingResponse) {
            logger.warn(
              `Middleware cannot replace a StreamingResponse for action '${action.name}'`,
            );
          } else {
            updatedResponse = middlewareResponse.updatedResponse;
          }
        }
      }
    }

    return updatedResponse;
  }

  private async executeWithTimeout(
    action: Action,
    params: Record<string, unknown>,
  ): Promise<Object> {
    const timeoutMs = action.timeout ?? config.actions.timeout;
    if (timeoutMs <= 0) return action.run(params, this);

    const controller = new AbortController();
    const timeoutError = new TypedError({
      message: `Action '${action.name}' timed out after ${timeoutMs}ms`,
      type: ErrorType.CONNECTION_ACTION_TIMEOUT,
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, timeoutMs);
    });

    return Promise.race([
      action.run(params, this, controller.signal),
      timeoutPromise,
    ]);
  }
  private async formatParams(params: Record<string, unknown>, action: Action) {
    if (!action.inputs) return {} as ActionParams<Action>;

    // Handle zod schema inputs
    if (
      typeof action.inputs === "object" &&
      action.inputs &&
      "safeParse" in action.inputs
    ) {
      // This is a zod schema - use safeParseAsync to support both sync and async transforms
      try {
        const result = await (action.inputs as any).safeParseAsync(params);
        if (!result.success) {
          // Get the first validation error (Zod v4 uses .issues instead of .errors)
          const firstError = result.error.issues[0];
          const key = firstError.path[0];
          const value = params[key];
          let message = firstError.message;
          // Zod v4: detect missing required param (code: "invalid_type" with undefined input)
          const isMissingRequired =
            firstError.code === "invalid_type" && value === undefined;
          if (isMissingRequired) {
            message = `Missing required param: ${key}`;
          }
          throw new TypedError({
            message,
            type: ErrorType.CONNECTION_ACTION_PARAM_REQUIRED,
            key,
            value,
          });
        }
        return result.data as ActionParams<Action>;
      } catch (e) {
        if (e instanceof TypedError) {
          throw e;
        }
        throw new TypedError({
          message: `Error validating params: ${e}`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          cause: e,
        });
      }
    }

    // If we get here, inputs is not a zod schema, return empty object
    return {} as ActionParams<Action>;
  }
}

function logAction(opts: {
  actionName: string | undefined;
  connectionType: string;
  status: "OK" | "ERROR";
  duration: number;
  params: Record<string, any>;
  method: string;
  url: string;
  identifier: string;
  correlationId: string | undefined;
  error: TypedError | undefined;
}) {
  if (config.logger.format === LogFormat.json) {
    const data: Record<string, any> = {
      action: opts.actionName,
      connectionType: opts.connectionType,
      status: opts.status,
      duration: opts.duration,
      params: opts.params,
    };
    if (opts.method) data.method = opts.method;
    if (opts.url) data.url = opts.url;
    if (opts.identifier) data.identifier = opts.identifier;
    if (opts.correlationId) data.correlationId = opts.correlationId;
    if (opts.error) {
      data.error = opts.error.message;
      data.errorType = opts.error.type;
      if (opts.error.stack) data.errorStack = opts.error.stack;
    }

    logger.info(`action: ${opts.actionName}`, data);
  } else {
    const loggingParams = config.logger.colorize
      ? ansi.gray(JSON.stringify(opts.params))
      : JSON.stringify(opts.params);

    const statusMessage = `[ACTION:${opts.connectionType.toUpperCase()}:${opts.status}]`;
    const messagePrefix = config.logger.colorize
      ? opts.status === "OK"
        ? ansi.bgBlue(statusMessage)
        : ansi.bgMagenta(statusMessage)
      : statusMessage;

    const errorStack =
      opts.error && opts.error.stack
        ? config.logger.colorize
          ? "\r\n" + ansi.gray(opts.error.stack)
          : "\r\n" + opts.error.stack
        : "";

    const correlationIdTag = opts.correlationId
      ? ` [cor:${opts.correlationId}]`
      : "";

    logger.info(
      `${messagePrefix} ${opts.actionName} (${opts.duration}ms) ${opts.method.length > 0 ? `[${opts.method}]` : ""} ${opts.identifier}${opts.url.length > 0 ? `(${opts.url})` : ""}${correlationIdTag} ${opts.error ? opts.error : ""} ${loggingParams} ${errorStack}`,
    );
  }
}

const REDACTED = "[[secret]]" as const;

const sanitizeParams = (
  params: Record<string, unknown>,
  action: Action | undefined,
) => {
  const sanitizedParams: Record<string, any> = {};

  // Get secret fields from the action's zod schema if it exists
  const secretFields = new Set<string>();
  if (action?.inputs && typeof action.inputs === "object") {
    const zodSchema = action.inputs as any;
    // In Zod v4, object schemas have a .shape property with the fields
    if (zodSchema.shape) {
      for (const [fieldName, fieldSchema] of Object.entries(zodSchema.shape)) {
        if (isSecret(fieldSchema as any)) {
          secretFields.add(fieldName);
        }
      }
    }
  }

  const maxParamLength = config.logger.maxParamLength;

  for (const [k, v] of Object.entries(params)) {
    if (secretFields.has(k)) {
      sanitizedParams[k] = REDACTED;
    } else if (maxParamLength > 0) {
      const stringified = typeof v === "string" ? v : JSON.stringify(v);
      if (stringified && stringified.length > maxParamLength) {
        sanitizedParams[k] =
          stringified.slice(0, maxParamLength) +
          `... (truncated, original length: ${stringified.length})`;
      } else {
        sanitizedParams[k] = v;
      }
    } else {
      sanitizedParams[k] = v;
    }
  }

  return sanitizedParams;
};
