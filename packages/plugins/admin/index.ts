import type { ActionMiddleware, KeryxPlugin } from "keryx";
import { loadFromEnvIfSet } from "keryx";
import { createAdminListAction } from "./actions/list";
import type { AdminActionOptions } from "./actions/options";
import {
  createAdminCreateAction,
  createAdminDestroyAction,
  createAdminShowAction,
  createAdminUpdateAction,
} from "./actions/records";
import {
  createAdminTableSchemaAction,
  createAdminTablesAction,
} from "./actions/tables";
import { createAdminUIAction } from "./actions/ui";
import pkg from "./package.json" with { type: "json" };
import type { AdminTableOptions, AdminTableRules } from "./util/registry";
import type { AdminResolveRole } from "./util/roles";

/**
 * Env-derived defaults, resolved once at module load. `adminPlugin()` is a synchronous
 * factory, so these can't be awaited inside it.
 */
const envDefaults = {
  enabled: await loadFromEnvIfSet("ADMIN_ENABLED", true),
  mcp: await loadFromEnvIfSet("ADMIN_MCP_ENABLED", false),
  route: await loadFromEnvIfSet("ADMIN_ROUTE", "/admin"),
  defaultLimit: await loadFromEnvIfSet("ADMIN_DEFAULT_LIMIT", 25),
  maxLimit: await loadFromEnvIfSet("ADMIN_MAX_LIMIT", 500),
};

export type { AdminAccess } from "./middleware/auth";
export { resolvedRole } from "./middleware/auth";
export type {
  AdminFilter,
  AdminFilterCondition,
  AdminFilterOperator,
} from "./util/filters";
export { ADMIN_FILTER_OPERATORS } from "./util/filters";
export type {
  AdminColumnKind,
  AdminColumnMeta,
  AdminTableMeta,
} from "./util/introspect";
export { describeTable } from "./util/introspect";
export type { AdminTableOptions, AdminTableRules } from "./util/registry";
export type { AdminResolveRole, AdminRole } from "./util/roles";
export { roleFromUserColumn } from "./util/roles";

export type AdminPluginOptions = {
  /**
   * Decides whether the caller may use the dashboard, and with which role. Required,
   * and intentionally so — there is no sensible default for "who is an admin here," and
   * a plugin that guessed would be a plugin that guessed wrong.
   *
   * Return `"full"` for read and write, `"read-only"` for browsing, or `null` to deny.
   */
  resolveRole: AdminResolveRole;

  /**
   * Restrict which tables are exposed. By default every table exported from the app's
   * `schema/` directory is browsable.
   */
  tables?: AdminTableOptions;

  /**
   * Per-table column rules, keyed by SQL table name. Hide secrets and mark
   * system-managed columns read-only:
   *
   * ```ts
   * columns: {
   *   users: { hidden: ["password_hash"], readOnly: ["created_at", "updated_at"] },
   * }
   * ```
   */
  columns?: Record<string, AdminTableRules>;

  /**
   * Middleware appended to every admin data action, after the role gate. The hook for
   * composing with the rest of your stack — `CsrfMiddleware` from `@keryxjs/csrf`,
   * `RateLimitMiddleware`, your own audit logger.
   */
  extraMiddleware?: ActionMiddleware[];
};

/**
 * Admin dashboard plugin for Keryx, in the spirit of RailsAdmin and Django's admin site.
 *
 * Browse, filter, and edit any table in your database without writing a screen per
 * model. Tables are discovered from `api.db.schema`, so a table added by a migration is
 * browsable as soon as it exists — no plugin change, no scaffolding step.
 *
 * Register it with a role resolver:
 *
 * ```ts
 * // config/plugins.ts
 * import { adminPlugin, roleFromUserColumn } from "@keryxjs/admin";
 * import { users } from "../schema/users";
 * import type { SessionImpl } from "../actions/session";
 *
 * export default {
 *   plugins: [
 *     adminPlugin({
 *       resolveRole: roleFromUserColumn<SessionImpl>({
 *         table: users,
 *         sessionKey: (session) => session.userId,
 *         role: (user) =>
 *           user.admin_role === "full" || user.admin_role === "read-only"
 *             ? user.admin_role
 *             : null,
 *       }),
 *       columns: { users: { hidden: ["password_hash"] } },
 *     }),
 *   ],
 * };
 * ```
 *
 * The dashboard then lives at `/api/admin`. Every JSON action is gated by the resolver;
 * `read-only` callers get 403 on writes.
 *
 * @param options - Role resolution plus optional table, column, and middleware rules.
 * @returns The plugin manifest, for `config.plugins`.
 */
export function adminPlugin(options: AdminPluginOptions): KeryxPlugin {
  const actionOptions: AdminActionOptions = {
    resolveRole: options.resolveRole,
    extraMiddleware: options.extraMiddleware ?? [],
  };

  return {
    name: pkg.name,
    version: pkg.version,
    actions: [
      createAdminUIAction(actionOptions),
      createAdminTablesAction(actionOptions),
      createAdminTableSchemaAction(actionOptions),
      createAdminListAction(actionOptions),
      createAdminShowAction(actionOptions),
      createAdminCreateAction(actionOptions),
      createAdminUpdateAction(actionOptions),
      createAdminDestroyAction(actionOptions),
    ],
    configDefaults: {
      admin: {
        ...envDefaults,
        tables: {
          include: options.tables?.include ?? [],
          exclude: options.tables?.exclude ?? [],
        },
        columns: options.columns ?? {},
      },
    },
  };
}

declare module "keryx" {
  interface KeryxConfig {
    admin: {
      /** When false, every admin action responds 404. Set via `ADMIN_ENABLED`. */
      enabled: boolean;
      /**
       * Exposes every admin data action as an MCP tool. One switch for the whole group:
       * granting an agent generic read/write access to your database is a single
       * decision, not eight. Off by default; set via `ADMIN_MCP_ENABLED`. Also requires
       * the MCP server itself (`MCP_SERVER_ENABLED`).
       */
      mcp: boolean;
      /** Route prefix for the dashboard and its API. Set via `ADMIN_ROUTE`. */
      route: string;
      /** Rows per page when the caller doesn't ask. Set via `ADMIN_DEFAULT_LIMIT`. */
      defaultLimit: number;
      /** Ceiling on rows per page, to keep one request from reading a whole table. Set via `ADMIN_MAX_LIMIT`. */
      maxLimit: number;
      /** Table allow/deny lists, from `adminPlugin({ tables })`. */
      tables: AdminTableOptions;
      /** Per-table column rules, from `adminPlugin({ columns })`. */
      columns: Record<string, AdminTableRules>;
    };
  }
}
