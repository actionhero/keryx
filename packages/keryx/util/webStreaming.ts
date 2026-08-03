/**
 * Transport-level bookkeeping for streaming HTTP responses.
 *
 * A `Response` whose body is produced incrementally must not be buffered, compressed,
 * or cut short by an idle timeout. There is no way to detect that from the `Response`
 * itself — every `Response` body is a `ReadableStream`, and a streaming body has no
 * `Content-Length` to distinguish it from a small JSON payload. So the code that
 * *creates* the response marks it here, and the web server reads the mark back when
 * deciding whether to compress and whether to disarm Bun's idle timeout.
 */

/**
 * Responses known to be streams. A `WeakSet` keeps this out of the response's own
 * headers (nothing leaks to the client) and lets the entries be collected with the
 * responses themselves.
 */
const streamingResponses = new WeakSet<Response>();

/**
 * Mark a response as a stream so the web server skips compression and disables the
 * idle timeout for it.
 *
 * @param response - The response to mark. Returned as-is for call-site chaining.
 * @returns The same response instance that was passed in.
 */
export function markStreamingResponse<T extends Response>(response: T): T {
  streamingResponses.add(response);
  return response;
}

/**
 * Check whether a response should be treated as a stream.
 *
 * True for responses explicitly marked by {@link markStreamingResponse} (anything from
 * `StreamingResponse.toResponse()`, plus raw `Response` passthrough from actions that
 * declare `web.streaming`), and for any `text/event-stream` response regardless of
 * origin — SSE is always incremental.
 *
 * @param response - The response to inspect.
 * @returns True when the body must be passed through untouched.
 */
export function isStreamingResponse(response: Response): boolean {
  if (streamingResponses.has(response)) return true;
  return (
    response.headers.get("Content-Type")?.includes("text/event-stream") ?? false
  );
}
