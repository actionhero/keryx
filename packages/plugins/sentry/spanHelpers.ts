import * as Sentry from "@sentry/bun";
import { ErrorStatusCodes, TypedError } from "keryx";

/**
 * A lazily-started, inactive Sentry span. The plugin creates spans this way
 * (rather than `startSpan`) so it can control their parent and lifetime by
 * hand across the framework's async hooks.
 */
export type SentrySpan = ReturnType<typeof Sentry.startInactiveSpan>;

/**
 * Build the `db.query.text` attribute for a Redis span: `"<command> <key>..."`
 * with keys-only (values never captured). Uses ioredis `Command.getKeys()`
 * to determine which args are keys; falls back to the command name alone if
 * the command isn't in `@ioredis/commands` or `getKeys()` throws.
 */
export function buildRedisQueryText(
  command: unknown,
  commandName: string,
): string {
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

/** Extract the SQL text from node-postgres `query()` arguments. */
export function queryTextFromArgs(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "text" in first) {
    const text = (first as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "query";
}

/** Derive the SQL operation (`SELECT`, `INSERT`, …) from a query's text. */
export function pgOperation(sqlText: string): string {
  const match = sqlText.trim().split(/\s+/)[0];
  return match ? match.toUpperCase() : "QUERY";
}

/** Cap SQL text length so span attributes stay bounded. */
export function truncateSql(sqlText: string, max = 1000): string {
  if (sqlText.length <= max) return sqlText;
  return `${sqlText.slice(0, max)}…`;
}

/** Map an error to the HTTP status Keryx would return for it. */
export function httpStatusForError(error: unknown): number {
  if (error instanceof TypedError) {
    return ErrorStatusCodes[error.type] ?? 500;
  }
  return 500;
}

/**
 * Decide whether an action error is worth a Sentry issue: 5xx / unexpected
 * always, 4xx `TypedError`s only when `captureClientErrors` is enabled.
 */
export function shouldCapture(
  error: unknown,
  captureClientErrors: boolean,
): boolean {
  return httpStatusForError(error) >= 500 || captureClientErrors;
}

/** Read a WebSocket frame's `messageType` without throwing on non-JSON. */
export function peekWsMessageType(message: string | Buffer): string {
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

/**
 * End a span when the wrapped operation settles. If `result` is a promise the
 * span is closed on resolve / reject (with the matching status); otherwise it
 * is ended synchronously. The original `result` is returned untouched.
 */
export function finishSpan(span: SentrySpan, result: unknown): unknown {
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
