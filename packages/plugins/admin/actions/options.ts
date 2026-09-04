import { type ActionMiddleware, config } from "keryx";
import {
  type AdminAccess,
  createAdminAuthMiddleware,
} from "../middleware/auth";
import type { AdminResolveRole } from "../util/roles";

/** What every admin action factory needs from plugin registration. */
export type AdminActionOptions = {
  resolveRole: AdminResolveRole;
  extraMiddleware: ActionMiddleware[];
};

/**
 * Assemble an admin action's middleware: the role gate first, then whatever the app
 * added at registration (CSRF, rate limiting). Order matters — an unauthorized caller
 * should be turned away before the app's middleware does any work on their behalf.
 *
 * @param options - Plugin registration options.
 * @param access - Whether the action reads or writes.
 * @returns Middleware array for the action.
 */
export function adminMiddleware(
  options: AdminActionOptions,
  access: AdminAccess,
): ActionMiddleware[] {
  return [
    createAdminAuthMiddleware(options.resolveRole, access),
    ...options.extraMiddleware,
  ];
}

/**
 * Whether admin actions should register as MCP tools.
 *
 * Read at action construction time, which the actions initializer runs after plugin
 * config defaults are merged — so `config.admin.mcp` is settled by the time this is
 * called. One switch covers every data action in the plugin: exposing a generic
 * "edit any row in any table" tool to an agent is a decision you make once, for the
 * whole surface, not per action.
 */
export function adminMcpEnabled() {
  return config.admin.mcp;
}
