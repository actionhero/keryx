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
      const bodyContent = (await req.json()) as Record<string, unknown>;
      // Merge JSON body directly — preserves types (objects, arrays, booleans, numbers)
      for (const [key, value] of Object.entries(bodyContent)) {
        params[key] = value;
      }
    } catch (e) {
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
