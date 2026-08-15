import * as Sentry from "@sentry/bun";
import type { Logger } from "keryx";
import { config, LogLevel, logger } from "keryx";

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
export function recordActionMetric(
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
 * that is filtered from stdout is never sent to Sentry either.
 *
 * @returns A function that restores the original `logger.log`, or `undefined`
 *   if the logger was already wrapped. The caller should invoke it on `stop()`
 *   so the singleton logger is never left double-wrapped across start/stop
 *   cycles (e.g. between tests).
 */
export function instrumentLogger(): (() => void) | undefined {
  const current = logger.log as Logger["log"] & { __sentryWrapped?: boolean };
  if (current.__sentryWrapped) return undefined;
  const original = current.bind(logger) as Logger["log"];
  const wrapped = ((level: LogLevel, message: string, data?: unknown) => {
    original(level, message, data);
    forwardLogToSentry(level, message, data);
  }) as Logger["log"] & { __sentryWrapped?: boolean };
  wrapped.__sentryWrapped = true;
  logger.log = wrapped;
  return () => {
    logger.log = original;
  };
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
function forwardLogToSentry(
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
  if (emit) emit(message, logAttributes(data));
}

/**
 * Normalize a framework log's `data` argument into Sentry log attributes.
 * Plain objects pass through as-is; anything else (arrays, primitives) is
 * nested under a `data` key so the attribute map stays a flat record.
 */
function logAttributes(data: unknown): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { data };
}
