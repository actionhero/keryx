import * as Sentry from "@sentry/bun";
import { api, config, ErrorStatusCodes, HTTP_METHOD, TypedError } from "keryx";

/**
 * A lazily-started, inactive Sentry span. The plugin creates spans this way
 * (rather than `startSpan`) so it can control their parent and lifetime by
 * hand across the framework's async hooks.
 */
export type SentrySpan = ReturnType<typeof Sentry.startInactiveSpan>;

/**
 * Attribute written onto a transport span that should not be sent. The plugin
 * registers this key with Sentry's `ignoreSpans` so marked spans are dropped
 * even if they are ended.
 */
export const TRACING_SKIP_ATTR = "keryx.tracing.skip";

/**
 * True unless the named action set `tracing = false`. Unknown or unresolved
 * names stay traced — opt-out is explicit.
 *
 * @param actionName - Action name from routing / `beforeAct`, or `undefined`
 *   when the request did not resolve to an action.
 */
export function isActionTraced(actionName: string | undefined): boolean {
  if (!actionName) return true;
  const action = api.actions.actions.find((a) => a.name === actionName);
  return action?.tracing !== false;
}

/**
 * Best-effort action name from an incoming HTTP request, used to skip the
 * HTTP span *before* session/DB work runs. Returns `undefined` when the path
 * does not match a web route.
 *
 * @param req - The incoming request. Only `url` and `method` are read.
 */
export function matchWebActionName(req: Request): string | undefined {
  try {
    const pathname = new URL(req.url).pathname;
    const pathToMatch = pathname.replace(
      new RegExp(config.server.web.apiRoute),
      "",
    );
    if (!pathToMatch) return undefined;
    const method = (req.method?.toUpperCase() ?? "GET") as HTTP_METHOD;
    return api.actions.router.match(pathToMatch, method)?.actionName;
  } catch {
    return undefined;
  }
}

/**
 * Read a WebSocket frame's `action` field without throwing on non-JSON.
 *
 * @param message - Raw WebSocket payload.
 */
export function peekWsActionName(message: string | Buffer): string | undefined {
  try {
    const parsed = JSON.parse(message.toString()) as { action?: unknown };
    return typeof parsed.action === "string" ? parsed.action : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mark a span so Sentry's `ignoreSpans` filter drops it on send.
 *
 * @param span - Live Sentry span to suppress.
 */
export function markSpanSkipped(span: SentrySpan): void {
  span.setAttribute(TRACING_SKIP_ATTR, true);
}

/**
 * True when this parent is a per-request / per-message / per-job transport
 * span that should be dropped along with an opted-out action — not a
 * long-lived connection/session span.
 *
 * @param span - Parent span from `spanALS` at `beforeAct` time.
 */
export function isDroppableTransportSpan(span: SentrySpan): boolean {
  const json = Sentry.spanToJSON(span);
  const op = json.op;
  const name = String(json.description ?? "");
  if (op === "http.server") return true;
  if (op === "queue.process") return true;
  if (name === "mcp.message") return true;
  if (name.startsWith("ws.message")) return true;
  return false;
}

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
