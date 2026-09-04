import { asc, count, desc } from "drizzle-orm";
import {
  type Action,
  api,
  config,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import { toActionError } from "../util/dbErrors";
import {
  type AdminFilter,
  adminFilterSchema,
  compileFilter,
} from "../util/filters";
import { selection } from "../util/records";
import {
  primaryKeyColumns,
  requireColumn,
  requireTable,
} from "../util/registry";
import {
  type AdminActionOptions,
  adminMcpEnabled,
  adminMiddleware,
} from "./options";

const sortSchema = z.object({
  column: z.string().min(1),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

/**
 * Build the `admin:table:list` action — the browse endpoint.
 *
 * `POST` rather than `GET` because a filter tree is a nested object, and the framework
 * only merges JSON request bodies for non-GET methods. Query strings can't carry
 * `{ or: [...] }` without inventing an encoding.
 */
export function createAdminListAction(options: AdminActionOptions) {
  return class AdminListAction implements Action {
    name = "admin:table:list";
    description =
      "Browse rows in a table with filtering, sorting, and pagination. Filters are a tree: a leaf is { column, op, value } where op is one of eq, neq, lt, lte, gt, gte, like, ilike, contains, startsWith, endsWith, in, notIn, isNull, isNotNull, between; branches combine leaves with { and: [...] }, { or: [...] }, or { not: {...} }.";
    inputs = z
      .object({
        table: z.string().min(1),
        filter: adminFilterSchema.optional(),
        sort: z.array(sortSchema).optional(),
      })
      .extend(
        paginationInputs({
          defaultLimit: config.admin.defaultLimit,
          maxLimit: config.admin.maxLimit,
        }).shape,
      );
    web = {
      route: `${config.admin.route}/tables/:table/list`,
      method: HTTP_METHOD.POST,
    };
    mcp = { tool: adminMcpEnabled() };
    middleware = adminMiddleware(options, "read");

    async run(params: {
      table: string;
      filter?: AdminFilter;
      sort?: Array<{ column: string; direction: "asc" | "desc" }>;
      page: number;
      limit: number;
    }) {
      const exposed = requireTable(params.table);
      const where = compileFilter(exposed, params.filter);

      // Without a deterministic order, paging through a table can show the same row
      // twice and skip another. Fall back to the primary key when the caller doesn't
      // specify a sort.
      const requestedSort = params.sort?.length
        ? params.sort
        : primaryKeyColumns(exposed).map((c) => ({
            column: c.name,
            direction: "asc" as const,
          }));

      const orderBy = requestedSort.map((entry) => {
        const column = requireColumn(exposed, entry.column);
        return entry.direction === "desc" ? desc(column) : asc(column);
      });

      const rowsQuery = api.db.db
        .select(selection(exposed))
        .from(exposed.table)
        .where(where)
        .orderBy(...orderBy);

      const countQuery = api.db.db
        .select({ count: count() })
        .from(exposed.table)
        .where(where);

      try {
        return await paginate(rowsQuery, countQuery, params);
      } catch (error) {
        throw toActionError(error, `list rows in "${exposed.name}"`);
      }
    }
  };
}
