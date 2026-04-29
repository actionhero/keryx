import type { parse } from "node:url";
import { api } from "../api";
import type { HTTP_METHOD } from "../classes/Action";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";

/**
 * Match a URL path + HTTP method against registered action routes.
 * Returns the action name and any extracted path parameters, or `null` if no match.
 *
 * Delegates to the pre-compiled `api.actions.router` for O(1) static-route lookup
 * and an ordered scan of parameterized routes. This function only handles the
 * transport concern of stripping the configured API prefix before routing.
 */
export async function determineActionName(
  url: ReturnType<typeof parse>,
  method: HTTP_METHOD,
): Promise<
  | { actionName: string; pathParams?: Record<string, string> }
  | { actionName: null; pathParams: null }
> {
  const pathToMatch = url.pathname?.replace(
    new RegExp(`${config.server.web.apiRoute}`),
    "",
  );

  if (!pathToMatch) return { actionName: null, pathParams: null };

  const match = api.actions.router.match(
    pathToMatch,
    method.toUpperCase() as HTTP_METHOD,
  );
  if (!match) return { actionName: null, pathParams: null };
  return { actionName: match.actionName, pathParams: match.pathParams };
}

/**
 * Reject requests whose body exceeds {@link config.server.web.maxBodySize}
 * based on the `Content-Length` header.
 *
 * This is a fast, zero-I/O pre-flight check. Requests that declare a body
 * size above the limit are rejected immediately with no body reading.
 * Chunked/streaming requests without `Content-Length` bypass this check —
 * they are caught by {@link readBodyWithLimit} during body parsing.
 *
 * @param req - The incoming HTTP request.
 * @throws {TypedError} With type {@link ErrorType.CONNECTION_ACTION_RUN} and
 *   an HTTP-friendly "Payload Too Large" message when the declared body
 *   size exceeds the configured limit.
 */
export function checkBodySize(req: Request): void {
  const maxBodySize = config.server.web.maxBodySize;
  if (maxBodySize <= 0) return;
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS")
    return;

  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const length = parseInt(contentLength, 10);
    if (!Number.isNaN(length) && length > maxBodySize) {
      throw new TypedError({
        message: `Payload Too Large — body of ${length} bytes exceeds the ${maxBodySize} byte limit`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
  }
}

/**
 * Read a request body as bytes, aborting early if the configured
 * {@link config.server.web.maxBodySize} is exceeded. Returns the body as a
 * UTF-8 string. Unlike `req.text()`, this never allocates the full oversized
 * payload — it reads the stream chunk-by-chunk and cancels as soon as the
 * limit is breached.
 *
 * @param req - The incoming HTTP request (body must not already be consumed).
 * @returns The body decoded as a UTF-8 string.
 * @throws {TypedError} With type {@link ErrorType.CONNECTION_ACTION_RUN}
 *   when the body exceeds the configured limit.
 */
async function readBodyWithLimit(req: Request): Promise<string> {
  const maxBodySize = config.server.web.maxBodySize;

  if (maxBodySize <= 0 || !req.body) {
    return await req.text();
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBodySize) {
      reader.cancel();
      throw new TypedError({
        message: `Payload Too Large — body exceeds the ${maxBodySize} byte limit`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Merge a value into the params object under `key`, appending to any existing
 * value rather than replacing it. If `key` is not set, assigns `value` as-is.
 * If it is set, produces an array containing the existing value(s) followed by
 * the incoming value(s). Used to fold body, form-data, and query string
 * sources into a single params object while preserving repeated keys.
 */
function appendParam(
  params: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (params[key] === undefined) {
    params[key] = value;
    return;
  }
  const incoming = Array.isArray(value) ? value : [value];
  params[key] = Array.isArray(params[key])
    ? [...(params[key] as unknown[]), ...incoming]
    : [params[key], ...incoming];
}

/**
 * Parse request parameters from path params, request body (JSON or form-data),
 * and query string into a single plain object.
 *
 * JSON bodies are preserved with full type fidelity (nested objects, arrays,
 * booleans, numbers). FormData bodies (multipart/form-data and
 * application/x-www-form-urlencoded) are converted to a plain object where
 * repeated keys become arrays and `File` values are preserved.
 *
 * @param req - The incoming HTTP request.
 * @param url - The parsed URL (for query string).
 * @param pathParams - Path parameters extracted by route matching.
 * @returns A plain object containing all merged parameters.
 */
export async function parseRequestParams(
  req: Request,
  url: ReturnType<typeof parse>,
  pathParams?: Record<string, string>,
): Promise<Record<string, unknown>> {
  // param load order: path params -> body params -> query params
  const params: Record<string, unknown> = {};

  // Add path parameters (always strings from URL segments)
  if (pathParams) {
    for (const [key, value] of Object.entries(pathParams)) {
      params[key] = String(value);
    }
  }

  if (
    req.method !== "GET" &&
    req.headers.get("content-type") === "application/json"
  ) {
    try {
      // Use streaming reader that aborts early if the body exceeds the
      // configured limit — never allocates the full oversized payload.
      const text = await readBodyWithLimit(req);
      const bodyContent = JSON.parse(text) as Record<string, unknown>;
      // Merge JSON body directly — preserves types (objects, arrays, booleans, numbers)
      for (const [key, value] of Object.entries(bodyContent)) {
        params[key] = value;
      }
    } catch (e) {
      if (e instanceof TypedError) throw e;
      throw new TypedError({
        message: `cannot parse request body: ${e}`,
        type: ErrorType.CONNECTION_ACTION_RUN,
        cause: e,
      });
    }
  } else if (
    req.method !== "GET" &&
    (req.headers.get("content-type")?.includes("multipart/form-data") ||
      req.headers
        .get("content-type")
        ?.includes("application/x-www-form-urlencoded"))
  ) {
    // For form data without a Content-Length header, stream-read the clone
    // to enforce the body size limit before handing off to the FormData parser.
    if (
      config.server.web.maxBodySize > 0 &&
      !req.headers.get("content-length")
    ) {
      await readBodyWithLimit(req.clone() as Request);
    }

    const f = await req.formData();
    f.forEach((value, key) => appendParam(params, key, value));
  }

  if (url.query) {
    for (const [key, values] of Object.entries(url.query)) {
      if (values !== undefined) appendParam(params, key, values);
    }
  }

  return params;
}
