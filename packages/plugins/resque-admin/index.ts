import type { KeryxPlugin } from "keryx";
import { loadFromEnvIfSet } from "keryx";
import { ResqueAdminDelayed } from "./actions/delayed";
import { ResqueAdminDelLock } from "./actions/delLock";
import { ResqueAdminDelQueue } from "./actions/delQueue";
import { ResqueAdminEnqueue } from "./actions/enqueue";
import { ResqueAdminFailed } from "./actions/failed";
import { ResqueAdminLocks } from "./actions/locks";
import { ResqueAdminOverview } from "./actions/overview";
import { ResqueAdminQueue } from "./actions/queue";
import { ResqueAdminRedisInfo } from "./actions/redisInfo";
import { ResqueAdminRemoveAllFailed } from "./actions/removeAllFailed";
import { ResqueAdminRemoveFailed } from "./actions/removeFailed";
import { ResqueAdminRetryFailed } from "./actions/retryFailed";
import { ResqueAdminUI } from "./actions/ui";
import pkg from "./package.json" with { type: "json" };

export { ResqueAdminPasswordMiddleware } from "./middleware/password";

const envDefaults = {
  serveUi: await loadFromEnvIfSet("RESQUE_ADMIN_SERVE_UI", true),
};

export type ResqueAdminPluginOptions = {
  /**
   * Serve the built-in HTML dashboard at `GET /resque-admin`. Set to `false` when you
   * ship your own UI against the JSON endpoints — the HTML action is then not
   * registered, so that route is free. Defaults to `true`, or `RESQUE_ADMIN_SERVE_UI`
   * when set.
   */
  serveUi?: boolean;
};

const dataActions = [
  ResqueAdminOverview,
  ResqueAdminFailed,
  ResqueAdminRetryFailed,
  ResqueAdminRemoveFailed,
  ResqueAdminRemoveAllFailed,
  ResqueAdminQueue,
  ResqueAdminDelQueue,
  ResqueAdminLocks,
  ResqueAdminDelLock,
  ResqueAdminDelayed,
  ResqueAdminRedisInfo,
  ResqueAdminEnqueue,
];

/**
 * Build a Resque Admin plugin instance.
 *
 * @param options - Optional UI serving flag. JSON endpoints are always registered.
 * @returns The plugin manifest, for `config.plugins`.
 */
export function createResqueAdminPlugin(
  options: ResqueAdminPluginOptions = {},
): KeryxPlugin {
  const serveUi = options.serveUi ?? envDefaults.serveUi;

  return {
    name: pkg.name,
    version: pkg.version,
    actions: [...(serveUi ? [ResqueAdminUI] : []), ...dataActions],
    configDefaults: {
      resqueAdmin: {
        password: "",
        serveUi,
      },
    },
  };
}

/**
 * Resque Admin plugin for Keryx. Provides a password-protected web dashboard
 * and API endpoints for monitoring Redis, queues, workers, failed jobs, and locks.
 *
 * Register in your config:
 * ```ts
 * // config/plugins.ts
 * import { resqueAdminPlugin } from "@keryxjs/resque-admin";
 * export default { plugins: [resqueAdminPlugin] };
 * ```
 *
 * Then set `config.resqueAdmin.password` to a strong password.
 *
 * To keep the JSON APIs and skip the built-in HTML (so you can ship your own UI):
 * ```ts
 * import { createResqueAdminPlugin } from "@keryxjs/resque-admin";
 * export default { plugins: [createResqueAdminPlugin({ serveUi: false })] };
 * ```
 */
export const resqueAdminPlugin: KeryxPlugin = createResqueAdminPlugin();

declare module "keryx" {
  interface KeryxConfig {
    resqueAdmin: {
      password: string;
      /**
       * When false, the built-in HTML dashboard is not served. JSON endpoints stay
       * available. Prefer `createResqueAdminPlugin({ serveUi: false })` so the UI
       * action is never registered. Set via `RESQUE_ADMIN_SERVE_UI`.
       */
      serveUi: boolean;
    };
  }
}
