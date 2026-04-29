import {
  type Action,
  type ActionMiddleware,
  type Connection,
  HTTP_METHOD,
} from "keryx";
import { z } from "zod";
import { ensureToken } from "../util/token";

/**
 * Build the `csrf:token` action class with the supplied middleware. The
 * factory exists so `csrfPlugin({ tokenActionMiddleware: [...] })` can attach
 * an app-specific session check (or any other guard) at registration time —
 * the plugin can't ship one because session shape is app-specific. The
 * returned class is registered via the plugin manifest in the usual way.
 */
export function createCsrfTokenAction(middleware: ActionMiddleware[]) {
  return class CsrfTokenAction implements Action {
    name = "csrf:token";
    description =
      "Issue (or refresh) the CSRF token bound to the caller's session. The same token is returned on subsequent calls until it expires or the session is regenerated. SPAs should call this once on bootstrap and send the token back via the csrfToken body/query param on state-changing requests.";
    inputs = z.object({});
    web = { route: "/csrf-token", method: HTTP_METHOD.GET };
    mcp = { tool: false };
    middleware = middleware;

    async run(_params: Record<string, never>, connection: Connection) {
      return ensureToken(connection.sessionId);
    }
  };
}

/**
 * Type of the `csrf:token` action instance, suitable for use with `ActionResponse`:
 * ```ts
 * import type { ActionResponse } from "keryx";
 * import type { CsrfTokenAction } from "@keryxjs/csrf";
 * const body = (await res.json()) as ActionResponse<CsrfTokenAction>;
 * ```
 */
export type CsrfTokenAction = InstanceType<
  ReturnType<typeof createCsrfTokenAction>
>;
