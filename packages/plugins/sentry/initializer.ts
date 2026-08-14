import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import * as Sentry from "@sentry/bun";
import {
  api,
  CONNECTION_TYPE,
  config,
  ErrorStatusCodes,
  Initializer,
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
  private wsConnections = new WeakMap<object, SentrySpan>();
  private wsMessageSpans = new WeakMap<object, SentrySpan>();
  private mcpSessions = new Map<string, SentrySpan>();
  private mcpMessageSpans = new Map<string, SentrySpan>();

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
      beforeSend: config.sentry.beforeSend,
      beforeSendSpan: config.sentry.beforeSendSpan,
      transport: config.sentry.transport,
      integrations: (integrations) =>
        integrations.filter((integration) => integration.name !== "BunServer"),
    });

    const ns = api.sentry;
    ns.enabled = true;
    ns.captureException = (exception) =>
      Sentry.captureException(exception) ?? undefined;
    ns.captureMessage = (message, level) =>
      Sentry.captureMessage(message, level) ?? undefined;
    ns.setUser = (user) => {
      Sentry.setUser(user);
    };
    ns.setTag = (key, value) => {
      Sentry.setTag(key, value);
    };
    ns.flush = (timeoutMs) => Sentry.flush(timeoutMs);

    this.registerTracingHooks();
    this.instrumentRedis();
    this.instrumentPostgres();

    logger.info(`Sentry tracing initialized (service: ${serviceName})`);
  }

  /**
   * Wire up Sentry spans and exception capture via framework hooks:
   *  - `web.beforeRequest` / `web.afterRequest`: root HTTP span
   *  - `ws.onConnect` / `onMessage` / `onDisconnect`: WebSocket transport
   *  - `mcp.onConnect` / `onMessage` / `onDisconnect`: MCP transport
   *  - `actions.beforeAct` / `actions.afterAct`: action span + errors
   *  - `actions.onEnqueue`: inject Sentry trace headers into task params
   *  - `resque.beforeJob` / `afterJob`: root `queue.process` transaction
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
   */
  private instrumentPostgres() {
    const pool = (
      api as {
        db?: {
          pool?: {
            query: (...args: unknown[]) => unknown;
            connect: (...args: unknown[]) => unknown;
          };
        };
      }
    ).db?.pool;
    if (!pool) return;

    const originalQuery = pool.query.bind(pool);
    pool.query = (...args: unknown[]) => {
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
      return finishSpan(span, originalQuery(...args));
    };

    const originalConnect = pool.connect.bind(pool);
    const wrapClient = (client: { query: (...args: unknown[]) => unknown }) => {
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
        return finishSpan(span, originalClientQuery(...args));
      };
    };

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
