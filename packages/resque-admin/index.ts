import type { KeryxPlugin } from "keryx";
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
 */
export const resqueAdminPlugin: KeryxPlugin = {
  name: pkg.name,
  version: pkg.version,
  actions: [
    ResqueAdminUI,
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
  ],
  configDefaults: {
    resqueAdmin: {
      password: "",
    },
  },
};

declare module "keryx" {
  interface KeryxConfig {
    resqueAdmin: {
      password: string;
    };
  }
}
