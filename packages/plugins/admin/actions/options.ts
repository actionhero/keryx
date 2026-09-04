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
  writeMiddleware: ActionMiddleware[];
};

/**
 * Assemble an admin action's middleware: the role gate first, then whatever the app
 * added at registration. Order matters — an unauthorized caller should be turned away
 * before the app's middleware does any work on their behalf.
 *
 * Write actions additionally get `writeMiddleware`. That split exists because CSRF is
 * the main thing apps want to add here, and a CSRF guard on a read would force the
 * token into a query string on GET requests — where it lands in access logs and
 * referrers.
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
    ...(access === "write" ? options.writeMiddleware : []),
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
