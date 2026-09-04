import {
  type Action,
  api,
  config,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import { toActionError } from "../util/dbErrors";
import { prepareValues, primaryKeyWhere, selection } from "../util/records";
import { type ExposedTable, requireTable } from "../util/registry";
import {
  type AdminActionOptions,
  adminMcpEnabled,
  adminMiddleware,
} from "./options";

/**
 * Primary key values keyed by column name. An object rather than a bare id so composite
 * keys work without a positional convention the caller has to guess.
 */
const pkSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

const valuesSchema = z.record(z.string(), z.unknown());

/**
 * Build the `admin:record:show` action. `POST` so the primary key can travel as a
 * structured object, which matters for composite keys.
 */
export function createAdminShowAction(options: AdminActionOptions) {
  return class AdminShowAction implements Action {
    name = "admin:record:show";
    description =
      "Fetch a single row by primary key. Pass `pk` as an object keyed by primary key column name, e.g. { id: 42 }.";
    inputs = z.object({ table: z.string().min(1), pk: pkSchema });
    web = {
      route: `${config.admin.route}/tables/:table/show`,
      method: HTTP_METHOD.POST,
    };
    mcp = { tool: adminMcpEnabled() };
    middleware = adminMiddleware(options, "read");

    async run(params: { table: string; pk: Record<string, unknown> }) {
      const exposed = requireTable(params.table);
      const where = primaryKeyWhere(exposed, params.pk);

      let rows: Record<string, unknown>[];
      try {
        rows = await api.db.db
          .select(selection(exposed))
          .from(exposed.table)
          .where(where)
          .limit(1);
      } catch (error) {
        throw toActionError(error, `read row from "${exposed.name}"`);
      }

      if (rows.length === 0) throw notFound(exposed, params.pk);

      return { record: rows[0] };
    }
  };
}

/** Build the `admin:record:create` action. */
export function createAdminCreateAction(options: AdminActionOptions) {
  return class AdminCreateAction implements Action {
    name = "admin:record:create";
    description =
      "Insert a row. Pass `values` keyed by column name; omitted columns take their database defaults. Requires the 'full' admin role.";
    inputs = z.object({ table: z.string().min(1), values: valuesSchema });
    web = {
      route: `${config.admin.route}/tables/:table/record`,
      method: HTTP_METHOD.PUT,
    };
    mcp = { tool: adminMcpEnabled() };
    middleware = adminMiddleware(options, "write");

    async run(params: { table: string; values: Record<string, unknown> }) {
      const exposed = requireTable(params.table);
      const values = prepareValues(exposed, params.values);

      try {
        const [record] = await api.db.db
          .insert(exposed.table)
          .values(values)
          .returning(selection(exposed));

        return { record };
      } catch (error) {
        throw toActionError(error, `create row in "${exposed.name}"`);
      }
    }
  };
}

/** Build the `admin:record:update` action. */
export function createAdminUpdateAction(options: AdminActionOptions) {
  return class AdminUpdateAction implements Action {
    name = "admin:record:update";
    description =
      "Update a row addressed by primary key. Pass `pk` keyed by primary key column and `values` keyed by column name; only the supplied columns change. Requires the 'full' admin role.";
    inputs = z.object({
      table: z.string().min(1),
      pk: pkSchema,
      values: valuesSchema,
    });
    web = {
      route: `${config.admin.route}/tables/:table/record`,
      method: HTTP_METHOD.POST,
    };
    mcp = { tool: adminMcpEnabled() };
    middleware = adminMiddleware(options, "write");

    async run(params: {
      table: string;
      pk: Record<string, unknown>;
      values: Record<string, unknown>;
    }) {
      const exposed = requireTable(params.table);
      const values = prepareValues(exposed, params.values);
      const where = primaryKeyWhere(exposed, params.pk);

      let rows: Record<string, unknown>[];
      try {
        rows = await api.db.db
          .update(exposed.table)
          .set(values)
          .where(where)
          .returning(selection(exposed));
      } catch (error) {
        throw toActionError(error, `update row in "${exposed.name}"`);
      }

      if (rows.length === 0) throw notFound(exposed, params.pk);

      return { record: rows[0] };
    }
  };
}

/** Build the `admin:record:destroy` action. */
export function createAdminDestroyAction(options: AdminActionOptions) {
  return class AdminDestroyAction implements Action {
    name = "admin:record:destroy";
    description =
      "Delete a row addressed by primary key. Pass `pk` keyed by primary key column name. Requires the 'full' admin role.";
    inputs = z.object({ table: z.string().min(1), pk: pkSchema });
    web = {
      route: `${config.admin.route}/tables/:table/record`,
      method: HTTP_METHOD.DELETE,
    };
    mcp = { tool: adminMcpEnabled() };
    middleware = adminMiddleware(options, "write");

    async run(params: { table: string; pk: Record<string, unknown> }) {
      const exposed = requireTable(params.table);
      const where = primaryKeyWhere(exposed, params.pk);

      let rows: Record<string, unknown>[];
      try {
        rows = await api.db.db
          .delete(exposed.table)
          .where(where)
          .returning(selection(exposed));
      } catch (error) {
        throw toActionError(error, `delete row from "${exposed.name}"`);
      }

      if (rows.length === 0) throw notFound(exposed, params.pk);

      return { record: rows[0] };
    }
  };
}

function notFound(exposed: ExposedTable, pk: Record<string, unknown>) {
  return new TypedError({
    message: `No row in "${exposed.name}" matching ${JSON.stringify(pk)}`,
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}
