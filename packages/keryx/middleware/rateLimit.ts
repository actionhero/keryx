import { api } from "../api";
import type { ActionMiddleware } from "../classes/Action";
import type { Connection } from "../classes/Connection";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";

/** Rate-limit metadata attached to `connection.rateLimitInfo` and used to set response headers. */
export type RateLimitInfo = {
  /** The max number of requests allowed in the current window. */
  limit: number;
  /** Requests remaining before the limit is hit. */
  remaining: number;
  /** Unix timestamp (seconds) when the current window resets. */
  resetAt: number;
  /** Seconds until the window resets. Only present when the limit has been exceeded. */
  retryAfter?: number;
};

/** Optional overrides for `checkRateLimit()` to use a custom limit/window instead of the global config. */
export type RateLimitOverrides = {
  /** Max requests per window. Defaults to the authenticated or unauthenticated config limit. */
  limit?: number;
  /** Window duration in milliseconds. Defaults to `config.rateLimit.windowMs`. */
  windowMs?: number;
  /** Redis key prefix. Defaults to `config.rateLimit.keyPrefix`. */
  keyPrefix?: string;
};

/**
 * Sliding-window rate-limit check using Redis. Exported so OAuth and other
 * non-action handlers can reuse it.
 *
 * @param identifier - A unique key for the client (e.g., `"ip:1.2.3.4"` or `"user:42"`).
 * @param isAuthenticated - Whether the caller is authenticated. Determines which
 *   config limit to use (authenticated vs unauthenticated).
 * @param overrides - Optional overrides for limit, window duration, or key prefix.
 * @returns Rate-limit metadata including remaining requests and retry-after (if limited).
 */
export async function checkRateLimit(
  identifier: string,
  isAuthenticated: boolean,
  overrides?: RateLimitOverrides,
): Promise<RateLimitInfo> {
  const windowMs = overrides?.windowMs ?? config.rateLimit.windowMs;
  const keyPrefix = overrides?.keyPrefix ?? config.rateLimit.keyPrefix;
  const limit =
    overrides?.limit ??
    (isAuthenticated
      ? config.rateLimit.authenticatedLimit
      : config.rateLimit.unauthenticatedLimit);
  const windowSizeSec = Math.ceil(windowMs / 1000);
  const now = Date.now();
  const currentWindow = Math.floor(now / windowMs);
  const previousWindow = currentWindow - 1;
  const windowProgress = (now % windowMs) / windowMs; // 0.0 to 1.0

  const currentKey = `${keyPrefix}:${identifier}:${currentWindow}`;
  const previousKey = `${keyPrefix}:${identifier}:${previousWindow}`;

  // Pipeline: increment current window, set TTL, and get previous window count
  const pipeline = api.redis.redis.pipeline();
  pipeline.incr(currentKey);
  pipeline.expire(currentKey, windowSizeSec * 2);
  pipeline.get(previousKey);
  const results = await pipeline.exec();

  const currentCount = (results![0][1] as number) || 0;
  const previousCount = parseInt((results![2][1] as string) || "0", 10);

  // Sliding window estimate: weight previous window by remaining overlap
  const estimatedCount =
    Math.floor(previousCount * (1 - windowProgress)) + currentCount;

  const remaining = Math.max(0, limit - estimatedCount);
  const resetAt = Math.ceil(((currentWindow + 1) * windowMs) / 1000);

  if (estimatedCount > limit) {
    const retryAfter = Math.ceil((windowMs - (now % windowMs)) / 1000);
    return { limit, remaining: 0, resetAt, retryAfter };
  }

  return { limit, remaining, resetAt };
}

/**
 * Build the HTTP 429 response for a request that exceeded a rate limit checked
 * outside the action pipeline (OAuth endpoints, the MCP endpoint). The body is
 * an OAuth-style `{ error, error_description }` object, and `Retry-After` plus
 * the `X-RateLimit-*` headers tell the client when to try again.
 *
 * @param info - The result of {@link checkRateLimit}; must have `retryAfter` set.
 * @param extraHeaders - Additional headers to include (e.g. CORS headers).
 */
export function rateLimitExceededResponse(
  info: RateLimitInfo,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: "rate_limit_exceeded",
      error_description: `Rate limit exceeded. Try again in ${info.retryAfter} seconds.`,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
        "Retry-After": String(info.retryAfter),
        "X-RateLimit-Limit": String(info.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(info.resetAt),
      },
    },
  );
}

/**
 * Action middleware that enforces per-connection rate limiting. Add to an action's
 * `middleware` array to apply. Throws `ErrorType.CONNECTION_RATE_LIMITED` when exceeded.
 */
export const RateLimitMiddleware: ActionMiddleware = {
  runBefore: async (_params, connection: Connection) => {
    if (!config.rateLimit.enabled) return;

    const isAuthenticated = !!connection.session?.data?.userId;
    const identifier = isAuthenticated
      ? `user:${connection.session!.data.userId}`
      : `ip:${connection.identifier}`;

    const info = await checkRateLimit(identifier, isAuthenticated);

    // Store on connection for header injection by web server
    connection.rateLimitInfo = info;

    if (info.retryAfter !== undefined) {
      throw new TypedError({
        message: `Rate limit exceeded. Try again in ${info.retryAfter} seconds.`,
        type: ErrorType.CONNECTION_RATE_LIMITED,
      });
    }
  },
};
