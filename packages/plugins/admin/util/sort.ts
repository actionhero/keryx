import { asc, desc, type SQL } from "drizzle-orm";
import {
  type ExposedTable,
  primaryKeyColumns,
  readableColumns,
  requireColumn,
} from "./registry";

export type AdminSortEntry = { column: string; direction: "asc" | "desc" };

/**
 * Build the `ORDER BY` for a listing, always ending in a deterministic tiebreaker.
 *
 * The tiebreaker is the point of this function. `LIMIT`/`OFFSET` pagination only works
 * if the total order is total: a sort on a non-unique column leaves tied rows in
 * whatever order the planner produces, and nothing requires that order to be the same
 * for the query that fetches page 1 and the one that fetches page 2. The result is a row
 * appearing on both pages while another never appears at all — silently, and more often
 * as the table grows past the point where a sequential scan happens to be stable.
 *
 * The primary key breaks every tie. A table without one falls back to ordering by every
 * readable column: that can't fully disambiguate, but any rows still tied are identical,
 * so which one is shown doesn't matter.
 *
 * @param exposed - Table resolved by `requireTable()`.
 * @param sort - Caller-requested sort entries, in precedence order. May be empty.
 * @returns Order-by clauses, never empty for a table with at least one readable column.
 * @throws {TypedError} With `ErrorType.CONNECTION_ACTION_RUN` if a requested column is
 * unknown or hidden.
 */
export function buildOrderBy(
  exposed: ExposedTable,
  sort: AdminSortEntry[] = [],
): SQL[] {
  const orderBy = sort.map((entry) => {
    const column = requireColumn(exposed, entry.column);
    return entry.direction === "desc" ? desc(column) : asc(column);
  });

  const alreadySorted = new Set(sort.map((entry) => entry.column));
  const keyColumns = primaryKeyColumns(exposed);
  const tiebreakers =
    keyColumns.length > 0 ? keyColumns : readableColumns(exposed);

  for (const column of tiebreakers) {
    if (alreadySorted.has(column.name)) continue;
    orderBy.push(asc(column));
  }

  return orderBy;
}
