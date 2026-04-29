import {
  type ActionMiddleware,
  CONNECTION_TYPE,
  type Connection,
  ErrorType,
  safeCompare,
  TypedError,
} from "keryx";
import { csrfConfig, getToken } from "../util/token";

/**
 * Action middleware that enforces CSRF protection on web HTTP requests. Add to
 * an action's `middleware` array. Only attach to state-changing actions — the
 * middleware is opt-in per action, with no method-based exemption.
 *
 * Reads the candidate token from the action's params under `config.csrf.paramName`
 * (default `csrfToken`). Apps must send the token as a JSON body field, form
 * field, or query string parameter. The token must match the value bound to the
 * caller's session in Redis (issued via `GET /csrf-token`). Note: protected
 * actions must declare `csrfToken` in their Zod input schema, otherwise the
 * default `.object()` strips it before middleware runs.
 *
 * Skipped for non-web transports (`task`, `cli`, `mcp`, `websocket`, `oauth`)
 * — those paths have no cross-site request concept.
 *
 * Throws `ErrorType.CONNECTION_CHANNEL_AUTHORIZATION` (HTTP 403) on missing,
 * mismatched, or expired tokens. Does not require an authenticated session;
 * compose with your app's session middleware separately if the action needs one.
 */
export const CsrfMiddleware: ActionMiddleware = {
  runBefore: async (params, connection: Connection) => {
    if (connection.type !== CONNECTION_TYPE.WEB) return;

    const submitted = (params as Record<string, unknown>)[
      csrfConfig().paramName
    ];

    if (typeof submitted !== "string" || submitted.length === 0) {
      throw new TypedError({
        message: "CSRF token missing",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }

    const expected = await getToken(connection.sessionId);
    if (!expected || !safeCompare(submitted, expected)) {
      throw new TypedError({
        message: "CSRF token invalid",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
  },
};
