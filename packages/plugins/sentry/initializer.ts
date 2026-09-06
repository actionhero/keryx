import path from "node:path";
import * as Sentry from "@sentry/bun";
import { api, config, Initializer, logger } from "keryx";
import { instrumentPostgres, instrumentRedis } from "./dbInstrumentation";
import { createNoopNamespace } from "./namespace";
import { TRACING_SKIP_ATTR } from "./spanHelpers";
import { SentryRequestState } from "./state";
import { instrumentLogger } from "./telemetry";
import { registerTracingHooks } from "./tracingHooks";

const namespace = "sentry";

/**
 * Sentry error monitoring and tracing plugin for Keryx. Provides spans for
 * HTTP / WebSocket / MCP transports, actions, background tasks, Redis
 * commands, and Postgres queries via framework hooks (`api.hooks.*`) — no
 * direct core modifications. Action failures become Sentry issues, and, when
 * enabled, real application logs and per-action metrics are forwarded too.
 *
 * The plugin is intentionally thin: it wires configuration into `Sentry.init`,
 * exposes the `api.sentry` surface, and delegates the actual instrumentation
 * to focused modules — `tracingHooks` (spans), `dbInstrumentation` (Redis /
 * Postgres), and `telemetry` (logs / metrics) — all sharing a single
 * {@link SentryRequestState}.
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
  /** Shared per-request span / identity state, passed to the instrumentation. */
  private state = new SentryRequestState();
  /**
   * Restores the framework logger's original `log` method. Set when logs are
   * enabled and the logger is wrapped in `start()`; called in `stop()` so the
   * singleton logger is never left wrapped across start/stop cycles.
   */
  private restoreLogger?: () => void;

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

  async initialize() {
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
      ignoreSpans: [{ attributes: { [TRACING_SKIP_ATTR]: true } }],
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
        this.state.applyRequestScope(scope);
        return Sentry.captureException(exception);
      }) ?? undefined;
    ns.captureMessage = (message, level) =>
      Sentry.withScope((scope) => {
        this.state.applyRequestScope(scope);
        return Sentry.captureMessage(message, level);
      }) ?? undefined;
    ns.setUser = (user) => {
      const data = this.state.requestScopeALS.getStore();
      if (data) {
        data.user = user;
      } else {
        // No active request context (e.g. called during boot). Fall back to
        // the global scope; there is no per-request isolation to preserve.
        Sentry.setUser(user);
      }
    };
    ns.setTag = (key, value) => {
      const data = this.state.requestScopeALS.getStore();
      if (data) {
        data.tags[key] = value;
      } else {
        Sentry.setTag(key, value);
      }
    };
    ns.flush = (timeoutMs) => Sentry.flush(timeoutMs);

    registerTracingHooks(this.state);
    instrumentRedis(
      this.state.spanALS,
      () => this.state.tracingSuppressedALS.getStore() === true,
    );
    instrumentPostgres(
      this.state.spanALS,
      () => this.state.tracingSuppressedALS.getStore() === true,
    );
    if (config.sentry.enableLogs) {
      // `instrumentLogger` returns `undefined` if the logger is already
      // wrapped; only overwrite the restorer when we actually wrapped it, so a
      // prior restore callback is never lost (which would leave `stop()` unable
      // to unwrap the singleton logger).
      const restore = instrumentLogger();
      if (restore) this.restoreLogger = restore;
    }

    logger.info(`Sentry tracing initialized (service: ${serviceName})`);
  }

  async stop() {
    const ns = api.sentry;
    Object.assign(ns, createNoopNamespace());

    if (this.restoreLogger) {
      this.restoreLogger();
      this.restoreLogger = undefined;
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

export type { SentryNamespace } from "./namespace";
