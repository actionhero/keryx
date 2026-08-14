import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import * as Sentry from "@sentry/bun";
import type { Logger } from "keryx";
import {
  api,
  CONNECTION_TYPE,
  config,
  ErrorStatusCodes,
  Initializer,
  LogLevel,
  logger,
  TypedError,
} from "keryx";

const namespace = "sentry";

/**
 * Public `api.sentry` surface. Methods are no-ops until the plugin starts
 * with a DSN; they stay safe to call from action code either way.
 */
export type SentryNamespace = {
  enabled: boolean;
  captureException: (exception: unknown) => string | undefined;
  captureMessage: (
    message: string,
    level?: Sentry.SeverityLevel,
  ) => string | undefined;
  setUser: (user: Sentry.User | null) => void;
  setTag: (key: string, value: string) => void;
  flush: (timeoutMs?: number) => Promise<boolean>;
};

declare module "keryx" {
  export interface API {
    [namespace]: SentryNamespace;
  }
}

type SentrySpan = ReturnType<typeof Sentry.startInactiveSpan>;

/**
 * Per-request identity buffer. `api.sentry.setUser` / `setTag` write here
 * instead of a process-global scope so that identity set while handling one
 * request never bleeds onto a concurrent or subsequent request's events. The
 * buffer is applied to a forked scope at capture time.
 */
type RequestScopeData = {
  user?: Sentry.User | null;
  tags: Record<string, string>;
};

/**
 * Build the `db.query.text` attribute for a Redis span: `"<command> <key>..."`
 * with keys-only (values never captured). Uses ioredis `Command.getKeys()`
 * to determine which args are keys; falls back to the command name alone if
 * the command isn't in `@ioredis/commands` or `getKeys()` throws.
 */
function buildRedisQueryText(command: unknown, commandName: string): string {
  try {
    const getKeys = (command as { getKeys?: () => Array<string | Buffer> })
      .getKeys;
    if (typeof getKeys !== "function") return commandName;
    const keys = getKeys.call(command);
    if (!Array.isArray(keys) || keys.length === 0) return commandName;
    return `${commandName} ${keys.map((k) => String(k)).join(" ")}`;
  } catch {
    return commandName;
  }
}

function queryTextFromArgs(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "text" in first) {
    const text = (first as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "query";
}

function pgOperation(sqlText: string): string {
  const match = sqlText.trim().split(/\s+/)[0];
  return match ? match.toUpperCase() : "QUERY";
}

function truncateSql(sqlText: string, max = 1000): string {
  if (sqlText.length <= max) return sqlText;
  return `${sqlText.slice(0, max)}…`;
}

function httpStatusForError(error: unknown): number {
  if (error instanceof TypedError) {
    return ErrorStatusCodes[error.type] ?? 500;
  }
  return 500;
}

function shouldCapture(error: unknown, captureClientErrors: boolean): boolean {
  return httpStatusForError(error) >= 500 || captureClientErrors;
}

function peekWsMessageType(message: string | Buffer): string {
  try {
    const parsed = JSON.parse(message.toString()) as {
      messageType?: unknown;
    };
    return typeof parsed.messageType === "string"
      ? parsed.messageType
      : "unknown";
  } catch {
    return "unknown";
  }
}

function finishSpan(span: SentrySpan, result: unknown): unknown {
  if (result && typeof (result as Promise<unknown>).then === "function") {
    (result as Promise<unknown>).then(
      () => {
        span.setStatus({ code: 1 });
        span.end();
      },
      (e: Error) => {
        span.setStatus({ code: 2, message: e.message });
        span.end();
      },
    );
  } else {
    span.end();
  }
  return result;
}

function createNoopNamespace(): SentryNamespace {
  return {
    enabled: false,
    captureException: () => undefined,
    captureMessage: () => undefined,
    setUser: () => {},
    setTag: () => {},
    flush: async () => true,
  };
}

/**
 * Sentry error monitoring and tracing plugin for Keryx. Provides spans for
 * HTTP / WebSocket / MCP transports, actions, background tasks, Redis
 * commands, and Postgres queries via framework hooks (`api.hooks.*`) — no
 * direct core modifications. Action failures become Sentry issues.
 *
 * Register via `config/plugins.ts`:
 * ```ts
 * import { sentryPlugin } from "@keryxjs/sentry";
 * export default { plugins: [sentryPlugin] };
 * ```
 *
 * Enable by setting `SENTRY_DSN`.
 */
export class SentryPlugin extends Initializer {
  /**
   * Active Sentry span for the current async task. Set via `enterWith` from
   * transport / action hooks so Redis and Postgres spans created later
   * inherit the right parent without wrapping the rest of the request in
   * `Sentry.startSpan(...)`.
   */
  private spanALS = new AsyncLocalStorage<SentrySpan | undefined>();
  /**
   * Per-request identity buffer keyed by async context. Established in
   * `beforeAct` (and transport hooks) so `setUser` / `setTag` isolate to the
   * current request instead of leaking through a shared global scope.
   */
  private requestScopeALS = new AsyncLocalStorage<
    RequestScopeData | undefined
  >();
  private wsConnections = new WeakMap<object, SentrySpan>();
  private wsMessageSpans = new WeakMap<object, SentrySpan>();
  private mcpSessions = new Map<string, SentrySpan>();
  private mcpMessageSpans = new Map<string, SentrySpan>();
  /**
   * The framework logger's original `log` method, saved when we wrap it to
   * forward logs to Sentry. Restored on `stop()` so the singleton logger is
   * never left double-wrapped across start/stop cycles (e.g. between tests).
   */
  private originalLoggerLog?: Logger["log"];

  constructor() {
    super(namespace);
    this.dependsOn = [
      "hooks",
      "actions",
      "connections",
      "servers",
      "redis",
      "db",
    ];
  }

  async initialize(): Promise<SentryNamespace> {
    return createNoopNamespace();
  }

  async start() {
    if (!config.sentry.enabled) return;
    if (!config.sentry.dsn) {
      logger.warn(
        "Sentry plugin is enabled but SENTRY_DSN is empty — staying dark",
      );
      return;
    }

    let appPkgName: string | undefined;
    try {
      const appPkg = (await Bun.file(
        path.join(api.rootDir, "package.json"),
      ).json()) as { name?: string };
      appPkgName = appPkg.name;
    } catch {
      // ignore — api.rootDir may not have a package.json in tests
    }
    const serviceName =
      config.observability.serviceName || appPkgName || "keryx";

    Sentry.init({
      dsn: config.sentry.dsn,
      environment: config.sentry.environment || undefined,
      release: config.sentry.release || undefined,
      tracesSampleRate: config.sentry.tracesSampleRate,
      sendDefaultPii: config.sentry.sendDefaultPii,
      debug: config.sentry.debug,
      serverName: serviceName,
      enableLogs: config.sentry.enableLogs,
      enableMetrics: config.sentry.enableMetrics,
      beforeSend: config.sentry.beforeSend,
      beforeSendSpan: config.sentry.beforeSendSpan,
      beforeSendLog: config.sentry.beforeSendLog,
      beforeSendMetric: config.sentry.beforeSendMetric,
      transport: config.sentry.transport,
      integrations: (integrations) =>
        integrations.filter((integration) => integration.name !== "BunServer"),
    });

    const ns = api.sentry;
    ns.enabled = true;
    ns.captureException = (exception) =>
      Sentry.withScope((scope) => {
        this.applyRequestScope(scope);
        return Sentry.captureException(exception);
      }) ?? undefined;
    ns.captureMessage = (message, level) =>
      Sentry.withScope((scope) => {
        this.applyRequestScope(scope);
        return Sentry.captureMessage(message, level);
      }) ?? undefined;
    ns.setUser = (user) => {
      const data = this.requestScopeALS.getStore();
      if (data) {
        data.user = user;
      } else {
        // No active request context (e.g. called during boot). Fall back to
        // the global scope; there is no per-request isolation to preserve.
        Sentry.setUser(user);
      }
    };
    ns.setTag = (key, value) => {
      const data = this.requestScopeALS.getStore();
      if (data) {
        data.tags[key] = value;
      } else {
        Sentry.setTag(key, value);
      }
    };
    ns.flush = (timeoutMs) => Sentry.flush(timeoutMs);

    this.registerTracingHooks();
    this.instrumentRedis();
    this.instrumentPostgres();
    if (config.sentry.enableLogs) this.instrumentLogger();

    logger.info(`Sentry tracing initialized (service: ${serviceName})`);
  }

  /**
   * Copy the current request's buffered identity (user + tags) onto a forked
   * Sentry scope. Called from a `withScope` callback right before a capture so
   * the identity applies only to that event, never to the shared global scope.
   */
  private applyRequestScope(scope: Sentry.Scope): void {
    const data = this.requestScopeALS.getStore();
    if (!data) return;
    if (data.user !== undefined) scope.setUser(data.user);
    for (const [key, value] of Object.entries(data.tags)) {
      scope.setTag(key, value);
    }
  }

  /**
   * Emit a Sentry metric for a completed action, off by default and gated on
   * `config.sentry.enableMetrics`.
   *
   * The metric is a counter named `keryx.action.count`, incremented once per
   * action with the action name and connection type as attributes so you can
   * break the count down by action in Sentry.
   *
   * @param actionName - Name of the action that ran, or `undefined` when the
   *   router could not resolve one (recorded as `unknown`).
   * @param connectionType - Transport the action ran on (web, websocket, task…).
   * @param outcome - Result of the action: `success` and `duration` in ms.
   */
  private recordActionMetric(
    actionName: string | undefined,
    connectionType: string,
    outcome: { success: boolean; duration: number },
  ): void {
    if (!config.sentry.enableMetrics) return;
    Sentry.metrics.count("keryx.action.count", 1, {
      attributes: {
        "keryx.action": actionName ?? "unknown",
        "keryx.connection.type": connectionType,
        "keryx.action.success": outcome.success,
      },
    });
  }

  /**
   * Forward the application's real logs to Sentry by wrapping the framework
   * `logger.log` method. Every log the app already emits — the same ones that
   * reach stdout — is mirrored to `Sentry.logger.<level>` with its structured
   * `data` carried through as log attributes. We do not invent logs; if the
   * app logs nothing, Sentry gets nothing.
   *
   * The wrapper preserves the logger's own level / `quiet` gating so a log
   * that is filtered from stdout is never sent to Sentry either. The original
   * method is saved on the instance and restored in `stop()`.
   */
  private instrumentLogger() {
    const current = logger.log as Logger["log"] & { __sentryWrapped?: boolean };
    if (current.__sentryWrapped) return;
    const original = current.bind(logger) as Logger["log"];
    this.originalLoggerLog = original;
    const self = this;
    const wrapped = ((level: LogLevel, message: string, data?: unknown) => {
      original(level, message, data);
      self.forwardLogToSentry(level, message, data);
    }) as Logger["log"] & { __sentryWrapped?: boolean };
    wrapped.__sentryWrapped = true;
    logger.log = wrapped;
  }

  /**
   * Mirror a single framework log line to Sentry, honoring the same level /
   * `quiet` filtering the logger applies to stdout. Structured `data` becomes
   * the Sentry log's attributes; primitive data is nested under a `data` key.
   *
   * @param level - The framework log level; maps 1:1 to a `Sentry.logger` method.
   * @param message - The log message.
   * @param data - Optional structured data attached to the log.
   */
  private forwardLogToSentry(
    level: LogLevel,
    message: string,
    data?: unknown,
  ): void {
    if (!config.sentry.enableLogs) return;
    if (logger.quiet) return;
    const levels = Object.values(LogLevel);
    if (levels.indexOf(level) < levels.indexOf(logger.level)) return;

    const emitters: Record<
      LogLevel,
      (message: string, attributes?: Record<string, unknown>) => void
    > = {
      [LogLevel.trace]: Sentry.logger.trace,
      [LogLevel.debug]: Sentry.logger.debug,
      [LogLevel.info]: Sentry.logger.info,
      [LogLevel.warn]: Sentry.logger.warn,
      [LogLevel.error]: Sentry.logger.error,
      [LogLevel.fatal]: Sentry.logger.fatal,
    };
    const emit = emitters[level];
    if (emit) emit(message, this.logAttributes(data));
  }

  /**
   * Normalize a framework log's `data` argument into Sentry log attributes.
   * Plain objects pass through as-is; anything else (arrays, primitives) is
   * nested under a `data` key so the attribute map stays a flat record.
   */
  private logAttributes(data: unknown): Record<string, unknown> | undefined {
    if (data === undefined || data === null) return undefined;
    if (typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return { data };
  }

  /**
   * Wire up Sentry spans and exception capture via framework hooks:
   *  - `web.beforeRequest` / `web.afterRequest`: root HTTP span
   *  - `ws.onConnect` / `onMessage` / `onDisconnect`: WebSocket transport
   *  - `mcp.onConnect` / `onMessage` / `onDisconnect`: MCP transport
   *  - `actions.beforeAct` / `actions.afterAct`: action span + errors
   *  - `actions.onEnqueue`: inject Sentry trace headers into task params
   *  - `resque.beforeJob` / `afterJob`: root `queue.process` transaction that
   *    continues the enqueuer's trace
   */
  private registerTracingHooks() {
    api.hooks.web.beforeRequest((req, ctx) => {
      const method = req.method?.toUpperCase() ?? "";
      const sentryTrace = req.headers.get("sentry-trace") ?? undefined;
      const baggage = req.headers.get("baggage") ?? undefined;
      const start = () =>
        Sentry.startInactiveSpan({
          name: method || "HTTP",
          op: "http.server",
          forceTransaction: true,
          attributes: {
            "http.request.method": method,
            "url.full": req.url,
          },
        });
      const httpSpan =
        sentryTrace || baggage
          ? Sentry.continueTrace({ sentryTrace, baggage }, start)
          : start();
      ctx.metadata.sentrySpan = httpSpan;
      this.spanALS.enterWith(httpSpan);
    });

    api.hooks.web.afterRequest((_req, _res, ctx, outcome) => {
      const httpSpan = ctx.metadata.sentrySpan as SentrySpan | undefined;
      if (!httpSpan) return;
      httpSpan.setAttribute("http.response.status_code", outcome.status);
      if (outcome.actionName) {
        httpSpan.setAttribute("http.route", outcome.actionName);
        Sentry.updateSpanName(
          httpSpan,
          `${outcome.method} ${outcome.actionName}`,
        );
      }
      if (outcome.status >= 400) {
        httpSpan.setStatus({ code: 2 });
      } else {
        httpSpan.setStatus({ code: 1 });
      }
      httpSpan.end();
    });

    api.hooks.ws.onConnect((connection) => {
      const span = Sentry.startInactiveSpan({
        name: "ws.connect",
        op: "ws.server",
        forceTransaction: true,
        attributes: {
          "keryx.connection.type": CONNECTION_TYPE.WEBSOCKET,
          "keryx.connection.id": connection.id,
        },
      });
      this.wsConnections.set(connection, span);
      this.spanALS.enterWith(span);
    });

    api.hooks.ws.onMessage((connection, message) => {
      const messageType = peekWsMessageType(message);
      const parent = this.wsConnections.get(connection);
      const span = Sentry.startInactiveSpan({
        name: `ws.message ${messageType}`,
        op: "ws.server",
        parentSpan: parent,
        attributes: {
          "keryx.connection.type": CONNECTION_TYPE.WEBSOCKET,
          "keryx.connection.id": connection.id,
          "keryx.ws.message_type": messageType,
        },
      });
      this.spanALS.enterWith(span);
      if (messageType === "action") {
        // End any previous in-flight action span for this connection before
        // overwriting the slot, so a burst of messages can't leak spans that
        // never reach afterAct.
        const prev = this.wsMessageSpans.get(connection);
        if (prev && prev !== span) prev.end();
        this.wsMessageSpans.set(connection, span);
      } else {
        span.setStatus({ code: 1 });
        span.end();
      }
    });

    api.hooks.ws.onDisconnect((connection) => {
      const pending = this.wsMessageSpans.get(connection);
      if (pending) {
        pending.end();
        this.wsMessageSpans.delete(connection);
      }
      const span = this.wsConnections.get(connection);
      if (!span) return;
      span.setStatus({ code: 1 });
      span.end();
      this.wsConnections.delete(connection);
    });

    api.hooks.mcp.onConnect((sessionId) => {
      const span = Sentry.startInactiveSpan({
        name: "mcp.connect",
        op: "mcp.server",
        forceTransaction: true,
        attributes: {
          "keryx.connection.type": CONNECTION_TYPE.MCP,
          "keryx.mcp.session_id": sessionId,
        },
      });
      this.mcpSessions.set(sessionId, span);
      this.spanALS.enterWith(span);
    });

    api.hooks.mcp.onMessage((sessionId) => {
      const parent = sessionId ? this.mcpSessions.get(sessionId) : undefined;
      const span = Sentry.startInactiveSpan({
        name: "mcp.message",
        op: "mcp.server",
        parentSpan: parent,
        attributes: {
          "keryx.connection.type": CONNECTION_TYPE.MCP,
          ...(sessionId ? { "keryx.mcp.session_id": sessionId } : {}),
        },
      });
      this.spanALS.enterWith(span);
      if (sessionId) {
        // onMessage fires for every session request — including pings and
        // notifications that never reach afterAct. End any previous in-flight
        // message span before overwriting the slot so those never accumulate
        // until disconnect.
        const prev = this.mcpMessageSpans.get(sessionId);
        if (prev && prev !== span) prev.end();
        this.mcpMessageSpans.set(sessionId, span);
      } else {
        span.setStatus({ code: 1 });
        span.end();
      }
    });

    api.hooks.mcp.onDisconnect((sessionId) => {
      const pending = this.mcpMessageSpans.get(sessionId);
      if (pending) {
        pending.end();
        this.mcpMessageSpans.delete(sessionId);
      }
      const span = this.mcpSessions.get(sessionId);
      if (!span) return;
      span.setStatus({ code: 1 });
      span.end();
      this.mcpSessions.delete(sessionId);
    });

    api.hooks.actions.beforeAct((actionName, _params, connection, actCtx) => {
      // Give each action its own identity buffer, seeded from the parent so a
      // nested connection.act() inherits the outer user/tags without mutating
      // them. afterAct restores the previous buffer, so sequential actions on a
      // long-lived async context (a WS connection or a task worker) never
      // inherit stale identity and it never bleeds across requests.
      const prevScope = this.requestScopeALS.getStore();
      actCtx.metadata.sentryPrevScope = prevScope;
      this.requestScopeALS.enterWith(
        prevScope
          ? { user: prevScope.user, tags: { ...prevScope.tags } }
          : { tags: {} },
      );
      const parent = this.spanALS.getStore();
      const actionSpan = Sentry.startInactiveSpan({
        name: `action:${actionName ?? "unknown"}`,
        op: "keryx.action",
        parentSpan: parent,
        attributes: {
          "keryx.action": actionName ?? "unknown",
          "keryx.connection.type": connection.type,
        },
      });
      actCtx.metadata.sentrySpan = actionSpan;
      actCtx.metadata.sentryParentSpan = parent;
      this.spanALS.enterWith(actionSpan);
    });

    api.hooks.actions.afterAct(
      (actionName, _params, connection, actCtx, outcome) => {
        this.recordActionMetric(actionName, connection.type, outcome);

        const span = actCtx.metadata.sentrySpan as SentrySpan | undefined;
        const parent = actCtx.metadata.sentryParentSpan as
          | SentrySpan
          | undefined;
        if (span) {
          span.setAttribute("keryx.action.duration_ms", outcome.duration);
          if (!outcome.success) {
            span.setStatus({
              code: 2,
              message:
                outcome.error instanceof Error
                  ? outcome.error.message
                  : String(outcome.error),
            });
            if (
              shouldCapture(outcome.error, config.sentry.captureClientErrors)
            ) {
              Sentry.withScope((scope) => {
                this.applyRequestScope(scope);
                scope.setTag("keryx.action", actionName);
                scope.setTag("keryx.connection.type", connection.type);
                Sentry.captureException(outcome.error);
              });
            }
          } else {
            span.setStatus({ code: 1 });
          }
          span.end();
        }

        // Nested connection.act() must not close the transport span — only the
        // outermost action (whose parent is the message/session span) does.
        if (connection.type === CONNECTION_TYPE.WEBSOCKET) {
          const messageSpan = this.wsMessageSpans.get(connection);
          if (messageSpan && messageSpan === parent) {
            messageSpan.setStatus({ code: outcome.success ? 1 : 2 });
            messageSpan.end();
            this.wsMessageSpans.delete(connection);
          }
        }
        if (connection.type === CONNECTION_TYPE.MCP) {
          let mcpSessionId: string | undefined;
          if (parent) {
            for (const [sid, s] of this.mcpMessageSpans) {
              if (s === parent) {
                mcpSessionId = sid;
                break;
              }
            }
          }
          if (parent && mcpSessionId !== undefined) {
            parent.setStatus({ code: outcome.success ? 1 : 2 });
            parent.end();
            this.mcpMessageSpans.delete(mcpSessionId);
          }
        }

        if (parent) this.spanALS.enterWith(parent);
        // Restore the identity buffer captured in beforeAct so this action's
        // user/tags do not leak into sibling or sequential actions sharing the
        // same async context (e.g. a task worker or WS connection).
        this.requestScopeALS.enterWith(
          actCtx.metadata.sentryPrevScope as RequestScopeData | undefined,
        );
      },
    );

    api.hooks.actions.onEnqueue((_actionName, inputs) => {
      if (!api.sentry.enabled) return;
      const parent = this.spanALS.getStore();
      if (!parent) return;
      // Ended spans (afterJob has already closed the job root) must not
      // propagate into enqueueRecurrent — that would chain cron runs.
      // Unsampled *live* spans still propagate so workers honor head sampling.
      if (typeof Sentry.spanToJSON(parent).timestamp === "number") return;
      const ctx = parent.spanContext();
      if (!ctx.traceId || !ctx.spanId) return;
      const sampled = ctx.traceFlags & 1 ? 1 : 0;
      const next: Record<string, unknown> = { ...inputs };
      next._sentryTrace = `${ctx.traceId}-${ctx.spanId}-${sampled}`;
      const baggage = Sentry.withActiveSpan(parent, () =>
        Sentry.getTraceData(),
      ).baggage;
      if (baggage) next._sentryBaggage = baggage;
      return next;
    });

    api.hooks.resque.beforeJob((actionName, params, jobCtx) => {
      const p = params as Record<string, unknown>;
      const sentryTrace = p._sentryTrace as string | undefined;
      const baggage = p._sentryBaggage as string | undefined;
      // Strip internal trace-propagation fields so they never reach the
      // action's validated params.
      delete p._sentryTrace;
      delete p._sentryBaggage;

      const start = () =>
        Sentry.startInactiveSpan({
          name: `task:${actionName}`,
          op: "queue.process",
          forceTransaction: true,
          attributes: {
            "keryx.action": actionName,
            "keryx.connection.type": CONNECTION_TYPE.TASK,
            "messaging.destination.name": jobCtx.queue || "default",
          },
        });
      const jobSpan =
        sentryTrace || baggage
          ? Sentry.continueTrace({ sentryTrace, baggage }, start)
          : start();
      jobCtx.metadata.sentrySpan = jobSpan;
      this.spanALS.enterWith(jobSpan);
    });

    api.hooks.resque.afterJob((_actionName, _params, jobCtx, outcome) => {
      const jobSpan = jobCtx.metadata.sentrySpan as SentrySpan | undefined;
      if (!jobSpan) return;
      if (outcome.success) {
        jobSpan.setStatus({ code: 1 });
      } else {
        jobSpan.setStatus({
          code: 2,
          message:
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error),
        });
      }
      jobSpan.end();
    });
  }

  /**
   * Wrap ioredis `sendCommand` on the main Redis client to emit a span per
   * command. Only the general-purpose client is instrumented; the subscription
   * client uses a different command flow for SUBSCRIBE/PSUBSCRIBE.
   *
   * Span `db.query.text` captures `<command> <key1> <key2>...` — keys only,
   * never values.
   */
  private instrumentRedis() {
    const client = api.redis?.redis;
    if (!client) return;
    const originalSendCommand = client.sendCommand.bind(client);
    const self = this;
    client.sendCommand = function (
      ...args: Parameters<typeof originalSendCommand>
    ) {
      const [command] = args;
      const commandName = (command as { name?: string }).name ?? "unknown";
      const queryText = buildRedisQueryText(command, commandName);
      const span = Sentry.startInactiveSpan({
        name: `redis.${commandName}`,
        op: "db",
        parentSpan: self.spanALS.getStore(),
        attributes: {
          "db.system": "redis",
          "db.operation.name": commandName,
          "db.query.text": queryText,
        },
      });
      return finishSpan(span, originalSendCommand(...args)) as ReturnType<
        typeof originalSendCommand
      >;
    } as typeof client.sendCommand;
  }

  /**
   * Wrap the node-postgres `Pool` used by Drizzle so every SQL command
   * (including those issued through `api.db.db`) becomes a Sentry span.
   * Query text is captured up to 1000 characters; bind values are not.
   *
   * Only the checked-out client's `query` is wrapped — never `Pool.query`.
   * `Pool.query` internally acquires a client via `Pool.connect` and delegates
   * to `client.query`, so wrapping both would emit two stacked `pg.*` spans per
   * statement. Wrapping only the client covers direct `Pool.query`, pooled
   * clients, and transactions with exactly one span each. Wrapped clients are
   * tracked in a `WeakSet` so pooled clients (reused across checkouts) are
   * never re-wrapped, which would otherwise grow the wrapper chain unbounded.
   */
  private instrumentPostgres() {
    const pool = (
      api as {
        db?: {
          pool?: {
            connect: (...args: unknown[]) => unknown;
          };
        };
      }
    ).db?.pool;
    if (!pool) return;

    const wrappedClients = new WeakSet<object>();
    const wrapClient = (client: { query: (...args: unknown[]) => unknown }) => {
      if (wrappedClients.has(client)) return;
      wrappedClients.add(client);
      const originalClientQuery = client.query.bind(client);
      client.query = (...args: unknown[]) => {
        const sqlText = queryTextFromArgs(args);
        const span = Sentry.startInactiveSpan({
          name: `pg.${pgOperation(sqlText)}`,
          op: "db",
          parentSpan: this.spanALS.getStore(),
          attributes: {
            "db.system": "postgresql",
            "db.operation.name": pgOperation(sqlText),
            "db.query.text": truncateSql(sqlText),
          },
        });
        // `Pool.query` calls `client.query(text, values, cb)` with a callback;
        // node-postgres returns a `Query` (not a thenable) in that form, so end
        // the span when the callback fires rather than immediately.
        const last = args[args.length - 1];
        if (typeof last === "function") {
          const cb = last as (...a: unknown[]) => unknown;
          args[args.length - 1] = (
            err: Error | undefined,
            ...rest: unknown[]
          ) => {
            if (err) {
              span.setStatus({ code: 2, message: err.message });
            } else {
              span.setStatus({ code: 1 });
            }
            span.end();
            return cb(err, ...rest);
          };
          return originalClientQuery(...args);
        }
        return finishSpan(span, originalClientQuery(...args));
      };
    };

    const originalConnect = pool.connect.bind(pool);
    pool.connect = (...args: unknown[]) => {
      const cb = args[0];
      if (typeof cb === "function") {
        return originalConnect(
          (
            err: Error | undefined,
            client: { query: (...args: unknown[]) => unknown },
            done: unknown,
          ) => {
            if (client) wrapClient(client);
            return (cb as (...a: unknown[]) => unknown)(err, client, done);
          },
        );
      }
      const result = originalConnect(...args);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return (
          result as Promise<{ query: (...args: unknown[]) => unknown }>
        ).then((client) => {
          wrapClient(client);
          return client;
        });
      }
      return result;
    };
  }

  async stop() {
    const ns = api.sentry;
    Object.assign(ns, createNoopNamespace());

    if (this.originalLoggerLog) {
      logger.log = this.originalLoggerLog;
      this.originalLoggerLog = undefined;
    }

    if (Sentry.getClient()) {
      try {
        await Promise.race([
          Sentry.close(config.sentry.shutdownTimeoutMs),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error("Sentry flush timed out on shutdown")),
              config.sentry.shutdownTimeoutMs,
            ),
          ),
        ]);
      } catch (e) {
        logger.warn(`Error flushing Sentry on shutdown: ${e}`);
      }
    }
  }
}
