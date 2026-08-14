import type { KeryxPlugin } from "keryx";
import { loadFromEnvIfSet } from "keryx";
import { SentryPlugin } from "./initializer";
import pkg from "./package.json" with { type: "json" };

type SentryInitOptions = NonNullable<
  Parameters<typeof import("@sentry/bun")["init"]>[0]
>;

const dsn = await loadFromEnvIfSet("SENTRY_DSN", "");

/**
 * The `@keryxjs/sentry` plugin — Sentry error monitoring and distributed
 * tracing for Keryx applications. Emits spans for HTTP, WebSocket, and MCP
 * transports, actions, background tasks, Redis commands, and Postgres
 * queries; captures action exceptions.
 *
 * Register in `config/plugins.ts`:
 * ```ts
 * import { sentryPlugin } from "@keryxjs/sentry";
 * export default { plugins: [sentryPlugin] };
 * ```
 *
 * Then set `SENTRY_DSN`. The plugin enables itself when a DSN is present;
 * set `SENTRY_ENABLED=false` to keep a DSN configured but stay dark.
 */
export const sentryPlugin: KeryxPlugin = {
  name: pkg.name,
  version: pkg.version,
  initializers: [SentryPlugin],
  configDefaults: {
    sentry: {
      enabled: await loadFromEnvIfSet("SENTRY_ENABLED", dsn !== ""),
      dsn,
      environment: await loadFromEnvIfSet("SENTRY_ENVIRONMENT", ""),
      release: await loadFromEnvIfSet("SENTRY_RELEASE", ""),
      tracesSampleRate: await loadFromEnvIfSet(
        "SENTRY_TRACES_SAMPLE_RATE",
        1.0,
      ),
      sendDefaultPii: await loadFromEnvIfSet("SENTRY_SEND_DEFAULT_PII", false),
      debug: await loadFromEnvIfSet("SENTRY_DEBUG", false),
      captureClientErrors: await loadFromEnvIfSet(
        "SENTRY_CAPTURE_CLIENT_ERRORS",
        false,
      ),
      shutdownTimeoutMs: await loadFromEnvIfSet(
        "SENTRY_SHUTDOWN_TIMEOUT_MS",
        2000,
      ),
    },
  },
};

declare module "keryx" {
  interface KeryxConfig {
    sentry: {
      /** Master toggle. Defaults to true when `dsn` is non-empty. */
      enabled: boolean;
      /** Sentry DSN. Required to send events. */
      dsn: string;
      /** Sentry environment tag (e.g. `production`). */
      environment: string;
      /** Release identifier attached to events and transactions. */
      release: string;
      /** Trace sampling ratio (0–1). */
      tracesSampleRate: number;
      /** Forward IP / user PII that Sentry would otherwise drop. */
      sendDefaultPii: boolean;
      /** Verbose Sentry SDK logging. */
      debug: boolean;
      /**
       * Capture 4xx `TypedError` failures (validation, not-found, auth)
       * in addition to 5xx / unexpected exceptions. Off by default —
       * client mistakes are rarely worth a Sentry issue.
       */
      captureClientErrors: boolean;
      /** Timeout in ms for flushing events on shutdown. */
      shutdownTimeoutMs: number;
      /**
       * Forwarded to `Sentry.init`. Useful for tests (a no-op transport)
       * and for PII filtering in production.
       */
      beforeSend?: SentryInitOptions["beforeSend"];
      /** Forwarded to `Sentry.init`. Useful for asserting spans in tests. */
      beforeSendSpan?: SentryInitOptions["beforeSendSpan"];
      /** Forwarded to `Sentry.init`. */
      transport?: SentryInitOptions["transport"];
    };
  }
}

export type { SentryNamespace } from "./initializer";
export { SentryPlugin };
