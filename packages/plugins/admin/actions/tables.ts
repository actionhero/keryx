import { count } from "drizzle-orm";
import { type Action, api, type Connection, config, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { resolvedRole } from "../middleware/auth";
import { describeTable } from "../util/introspect";
import { exposedTables, requireTable } from "../util/registry";
import {
  type AdminActionOptions,
  adminMcpEnabled,
  adminMiddleware,
} from "./options";

/**
 * Build the `admin:tables` action: the dashboard's entry point. Lists every exposed
 * table with its row count, and echoes back the caller's role so the client knows
 * whether to render write controls at all.
 */
export function createAdminTablesAction(options: AdminActionOptions) {
  return class AdminTablesAction implements Action {
    name = "admin:tables";
    description =
      "List the database tables the admin dashboard can browse, with row counts. Also returns the caller's admin role ('read-only' or 'full').";
    inputs = z.object({});
    web = {
      route: `${config.admin.route}/tables`,
      method: HTTP_METHOD.GET,
    };
    mcp = { tool: adminMcpEnabled() };
    middleware = adminMiddleware(options, "read");

    async run(_params: Record<string, never>, connection: Connection) {
      const tables = await Promise.all(
        exposedTables().map(async (exposed) => {
          const [row] = await api.db.db
            .select({ value: count() })
            .from(exposed.table);

          return {
            name: exposed.name,
            exportName: exposed.exportName,
            rows: row?.value ?? 0,
            writable: describeTable(exposed).writable,
          };
        }),
      );

      return { role: resolvedRole(connection) ?? null, tables };
    }
  };
}

/**
 * Build the `admin:table:schema` action. Clients call this once per table and use the
 * result to render columns, pick input widgets, and validate before submitting.
 */
export function createAdminTableSchemaAction(options: AdminActionOptions) {
  return class AdminTableSchemaAction implements Action {
    name = "admin:table:schema";
    description =
      "Describe one table: its columns with SQL types, nullability, uniqueness, defaults, enum values, and foreign key targets, plus its primary key.";
    inputs = z.object({ table: z.string().min(1) });
    web = {
      route: `${config.admin.route}/tables/:table/schema`,
      method: HTTP_METHOD.GET,
    };
    mcp = { tool: adminMcpEnabled() };
    middleware = adminMiddleware(options, "read");

    async run(params: { table: string }) {
      return describeTable(requireTable(params.table));
    }
  };
}
