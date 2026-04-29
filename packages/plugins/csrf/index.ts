import type { ActionMiddleware, KeryxPlugin } from "keryx";
import { createCsrfTokenAction } from "./actions/csrfToken";
import pkg from "./package.json" with { type: "json" };

export type { CsrfTokenAction } from "./actions/csrfToken";
export { CsrfMiddleware } from "./middleware/csrf";
export { ensureToken, getToken } from "./util/token";

export type CsrfPluginOptions = {
  /**
   * Middleware applied to the built-in `csrf:token` action. Use this to
   * attach your app's session check so anonymous callers can't mint tokens
   * against the framework's auto-created anonymous session. Defaults to `[]`
   * — set to `[YourSessionMiddleware]` in production.
   */
  tokenActionMiddleware?: ActionMiddleware[];
};

/**
 * CSRF protection plugin for Keryx. Adds a `GET /csrf-token` endpoint that
 * issues a per-session token, and a `CsrfMiddleware` that validates the token
 * on state-changing requests.
 *
 * Register in your config, passing the session middleware that should guard
 * `/csrf-token`:
 * ```ts
 * // config/plugins.ts
 * import { csrfPlugin } from "@keryxjs/csrf";
 * import { SessionMiddleware } from "../middleware/session";
 * export default {
 *   plugins: [csrfPlugin({ tokenActionMiddleware: [SessionMiddleware] })],
 * };
 * ```
 *
 * Then attach `CsrfMiddleware` to any action you want to protect:
 * ```ts
 * import { CsrfMiddleware } from "@keryxjs/csrf";
 * class MessageCreate implements Action {
 *   middleware = [SessionMiddleware, CsrfMiddleware];
 *   web = { route: "/message", method: HTTP_METHOD.PUT };
 *   inputs = z.object({ body: z.string(), csrfToken: z.string().optional() });
 *   // ...
 * }
 * ```
 */
export function csrfPlugin(opts: CsrfPluginOptions = {}): KeryxPlugin {
  return {
    name: pkg.name,
    version: pkg.version,
    actions: [createCsrfTokenAction(opts.tokenActionMiddleware ?? [])],
    configDefaults: {
      csrf: {
        tokenTtl: 3600,
        paramName: "csrfToken",
        redisKeyPrefix: "csrf:token",
      },
    },
  };
}

declare module "keryx" {
  interface KeryxConfig {
    csrf: {
      /** Token lifetime in seconds. Refreshed on each `/csrf-token` fetch. */
      tokenTtl: number;
      /** Action params field name to read the submitted token from. */
      paramName: string;
      /** Redis key prefix for stored tokens. */
      redisKeyPrefix: string;
    };
  }
}
