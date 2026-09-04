import { getTableName } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { api, config, ErrorType, TypedError } from "keryx";

/**
 * Per-table visibility rules. Keys are SQL table names, matching what the browser
 * and MCP callers send.
 */
export type AdminTableRules = {
  /** Columns hidden from listings, records, and writes. Use for password hashes and tokens. */
  hidden?: string[];
  /** Columns readable but never writable. Use for computed or system-managed values. */
  readOnly?: string[];
};

export type AdminTableOptions = {
  /** When set, only these tables are exposed. Everything else is invisible. */
  include?: string[];
  /** Tables to hide. Applied after `include`. */
  exclude?: string[];
};

/**
 * An exposed table plus the rules that govern it. Every action resolves one of these
 * before touching the database, so visibility is enforced in exactly one place.
 */
export type ExposedTable = {
  /** SQL table name, as PostgreSQL knows it. */
  name: string;
  /** Export name from the app's `schema/` directory. */
  exportName: string;
  table: PgTable;
  rules: AdminTableRules;
};

function adminConfig() {
  return config.admin;
}

/**
 * List the tables the dashboard may touch, sorted by name for stable UI ordering.
 *
 * Reads `api.db.schema` — the registry the framework builds from the app's `schema/`
 * directory — then applies the plugin's `include`/`exclude` rules. A table absent from
 * `schema/` is invisible to the dashboard no matter what the caller asks for, which is
 * what keeps migration bookkeeping tables like `__drizzle_migrations` out of reach.
 *
 * @returns Exposed tables with their column rules attached.
 */
export function exposedTables(): ExposedTable[] {
  const { tables, columns } = adminConfig();
  const include = tables.include ?? [];
  const exclude = tables.exclude ?? [];

  const results: ExposedTable[] = [];

  for (const [exportName, table] of Object.entries(api.db.schema)) {
    const name = getTableName(table);

    if (include.length > 0 && !include.includes(name)) continue;
    if (exclude.includes(name)) continue;

    results.push({
      name,
      exportName,
      table,
      rules: columns[name] ?? {},
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a caller-supplied table name to an exposed table.
 *
 * Hidden and unknown tables fail identically — a caller probing for `users` learns
 * nothing about whether it exists but is hidden, or was never there.
 *
 * @param name - SQL table name from request params.
 * @returns The exposed table and its rules.
 * @throws {TypedError} With `ErrorType.CONNECTION_ACTION_RUN` when the table is unknown or hidden.
 */
export function requireTable(name: string): ExposedTable {
  const match = exposedTables().find((t) => t.name === name);

  if (!match) {
    throw new TypedError({
      message: `Unknown table: ${name}`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }

  return match;
}

/**
 * The columns of a table that callers may read, in schema declaration order.
 *
 * @param exposed - Table resolved by {@link requireTable}.
 * @returns Drizzle columns with `hidden` entries removed.
 */
export function readableColumns(exposed: ExposedTable) {
  const hidden = exposed.rules.hidden ?? [];
  return getTableConfig(exposed.table).columns.filter(
    (c) => !hidden.includes(c.name),
  );
}

/**
 * Resolve a caller-supplied column name against a table, so filter, sort, and write
 * params can never reach a column the caller isn't allowed to see. Validating names
 * against real Drizzle column objects — rather than interpolating strings into SQL —
 * is what makes the generic query builder safe.
 *
 * @param exposed - Table resolved by {@link requireTable}.
 * @param name - Column name from request params.
 * @returns The Drizzle column.
 * @throws {TypedError} With `ErrorType.CONNECTION_ACTION_RUN` when the column is unknown or hidden.
 */
export function requireColumn(exposed: ExposedTable, name: string) {
  const column = readableColumns(exposed).find((c) => c.name === name);

  if (!column) {
    throw new TypedError({
      message: `Unknown column "${name}" on table "${exposed.name}"`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }

  return column;
}

/**
 * The columns a caller may write. Excludes hidden columns, columns marked `readOnly`
 * in config, and generated columns the database computes itself.
 *
 * @param exposed - Table resolved by {@link requireTable}.
 * @returns Writable Drizzle columns.
 */
export function writableColumns(exposed: ExposedTable) {
  const readOnly = exposed.rules.readOnly ?? [];
  return readableColumns(exposed).filter(
    (c) => !readOnly.includes(c.name) && !c.generated,
  );
}

/**
 * The primary key as the schema declares it: an explicit composite key when the table
 * has one, otherwise whichever columns are marked `primary`.
 *
 * Ignores the `hidden` rules on purpose, because this is a statement about the table
 * rather than about what a caller may see. Use it where the key is a means and never
 * surfaces — a deterministic `ORDER BY`, say, which reveals nothing about the values it
 * sorts on. Anything that discloses the key or addresses a row wants
 * {@link addressableKeyColumns} instead.
 *
 * @param exposed - Table resolved by {@link requireTable}.
 * @returns Primary key columns, empty when the table has none.
 */
export function primaryKeyColumns(exposed: ExposedTable) {
  const { columns, primaryKeys } = getTableConfig(exposed.table);

  if (primaryKeys.length > 0) return primaryKeys[0].columns;

  return columns.filter((c) => c.primary);
}

/**
 * The primary key columns a caller may actually use to address a row.
 *
 * Empty when any part of the key is hidden. Hiding a primary key is unusual, but the
 * alternative is incoherent: the key wouldn't appear in returned rows, so a caller
 * couldn't supply it, yet the table would still advertise itself as writable and every
 * row action would fail on a key value nobody could have known. Reporting no
 * addressable key makes such a table browse-only, and keeps the hidden column
 * indistinguishable from one that doesn't exist.
 *
 * @param exposed - Table resolved by {@link requireTable}.
 * @returns Addressable primary key columns, empty when there is no usable key.
 */
export function addressableKeyColumns(exposed: ExposedTable) {
  const hidden = exposed.rules.hidden ?? [];
  const keyColumns = primaryKeyColumns(exposed);

  if (keyColumns.some((c) => hidden.includes(c.name))) return [];

  return keyColumns;
}
