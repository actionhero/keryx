import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ErrorType, TypedError } from "keryx";
import { coerceValue } from "./coerce";
import {
  type ExposedTable,
  primaryKeyColumns,
  readableColumns,
  requireColumn,
  writableColumns,
} from "./registry";

type Operand = Parameters<typeof eq<PgColumn>>[1];

/**
 * Build a `WHERE` clause matching exactly one row by primary key.
 *
 * Every write goes through here, which is what guarantees the dashboard can't issue an
 * unbounded `UPDATE` or `DELETE`. A table without a primary key is refused outright
 * rather than falling back to matching on arbitrary columns.
 *
 * @param exposed - Table resolved by `requireTable()`.
 * @param pk - Caller-supplied primary key values, keyed by column name.
 * @returns A clause matching one row.
 * @throws {TypedError} With `ErrorType.CONNECTION_ACTION_RUN` when the table has no
 * primary key, or when the caller omitted part of a composite key.
 */
export function primaryKeyWhere(
  exposed: ExposedTable,
  pk: Record<string, unknown>,
): SQL {
  const keyColumns = primaryKeyColumns(exposed);

  if (keyColumns.length === 0) {
    throw new TypedError({
      message: `Table "${exposed.name}" has no primary key, so individual rows cannot be addressed`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }

  const conditions = keyColumns.map((keyColumn) => {
    const value = pk[keyColumn.name];

    if (value === undefined || value === null) {
      const expected = keyColumns.map((c) => c.name).join(", ");
      throw new TypedError({
        message: `Missing primary key value "${keyColumn.name}" for table "${exposed.name}" (expects: ${expected})`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }

    // Resolve through the registry so a hidden primary key can't be targeted.
    const column = requireColumn(exposed, keyColumn.name);
    return eq(column, coerceValue(column, value) as Operand);
  });

  // `and()` returns undefined only for an empty list, which the guard above rules out.
  return and(...conditions) as SQL;
}

/**
 * Validate and coerce a caller-supplied set of column values for an insert or update.
 *
 * Keys are checked against the table's writable columns, so hidden columns, `readOnly`
 * columns, and columns that don't exist are all rejected before the query is built.
 * Values are only coerced toward their column's shape — the database does the
 * validating.
 *
 * @param exposed - Table resolved by `requireTable()`.
 * @param values - Raw column values from request params.
 * @returns Coerced values keyed by column name, ready for Drizzle.
 * @throws {TypedError} With `ErrorType.CONNECTION_ACTION_RUN` when no writable values
 * were supplied, or a key isn't a writable column.
 */
export function prepareValues(
  exposed: ExposedTable,
  values: Record<string, unknown>,
) {
  const writable = writableColumns(exposed);
  const prepared: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(values)) {
    const column = writable.find((c) => c.name === name);

    if (!column) {
      const readable = readableColumns(exposed).some((c) => c.name === name);
      throw new TypedError({
        message: readable
          ? `Column "${name}" on table "${exposed.name}" is read-only`
          : `Unknown column "${name}" on table "${exposed.name}"`,
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }

    // Drizzle keys insert/update objects by TS property name, not SQL column name.
    prepared[columnKey(exposed, column)] = coerceValue(column, value);
  }

  if (Object.keys(prepared).length === 0) {
    throw new TypedError({
      message: `No writable columns supplied for table "${exposed.name}"`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }

  return prepared;
}

/**
 * Find the TypeScript property name for a column. Drizzle's `.values()` and `.set()`
 * take the schema's property keys, which differ from SQL names whenever the schema
 * author renamed a column (`createdAt: timestamp("created_at")`).
 */
function columnKey(exposed: ExposedTable, column: PgColumn) {
  const entry = Object.entries(exposed.table).find(
    ([, value]) => value === column,
  );
  return entry?.[0] ?? column.name;
}

/**
 * Build the `select` projection for a table, excluding hidden columns and keyed by SQL
 * column name so responses are predictable for clients that only have the metadata
 * from `describeTable()`.
 *
 * @param exposed - Table resolved by `requireTable()`.
 * @returns Projection object for `db.select(...)`.
 */
export function selection(exposed: ExposedTable) {
  const projection: Record<string, PgColumn> = {};
  for (const column of readableColumns(exposed)) {
    projection[column.name] = column;
  }
  return projection;
}
