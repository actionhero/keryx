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
 * Chunked/streaming requests without `Content-Length` bypass this check and
 * are instead enforced inside {@link parseRequestParams} after the body is
 * read as text.
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

  const maxBodySize = config.server.web.maxBodySize;

  if (
    req.method !== "GET" &&
    req.headers.get("content-type") === "application/json"
  ) {
    try {
      // Read as text first to enforce body size for chunked requests that
      // bypassed the Content-Length pre-flight check in checkBodySize().
      const text = await req.text();
      if (maxBodySize > 0 && text.length > maxBodySize) {
        throw new TypedError({
          message: `Payload Too Large — body exceeds the ${maxBodySize} byte limit`,
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
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
    // For form data without a Content-Length header, read as text first to
    // enforce body size before handing off to the FormData parser.
    if (
      maxBodySize > 0 &&
      !req.headers.get("content-length") &&
      req.headers
        .get("content-type")
        ?.includes("application/x-www-form-urlencoded")
    ) {
      const text = await req.clone().text();
      if (text.length > maxBodySize) {
        throw new TypedError({
          message: `Payload Too Large — body exceeds the ${maxBodySize} byte limit`,
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
    }

    const f = await req.formData();
    f.forEach((value, key) => {
      if (params[key] !== undefined) {
        if (Array.isArray(params[key])) {
          (params[key] as unknown[]).push(value);
        } else {
          params[key] = [params[key], value];
        }
      } else {
        params[key] = value;
      }
    });
  }

  if (url.query) {
    for (const [key, values] of Object.entries(url.query)) {
      if (values !== undefined) {
        if (Array.isArray(values)) {
          if (params[key] !== undefined) {
            if (Array.isArray(params[key])) {
              (params[key] as unknown[]).push(...values);
            } else {
              params[key] = [params[key], ...values];
            }
          } else {
            params[key] = values;
          }
        } else {
          if (params[key] !== undefined) {
            if (Array.isArray(params[key])) {
              (params[key] as unknown[]).push(values);
            } else {
              params[key] = [params[key], values];
            }
          } else {
            params[key] = values;
          }
        }
      }
    }
  }

  return params;
}
