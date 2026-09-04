import { getTableName } from "drizzle-orm";
import { getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import {
  addressableKeyColumns,
  type ExposedTable,
  readableColumns,
  writableColumns,
} from "./registry";

/** Broad shape used by the UI to pick an input widget and by clients to coerce values. */
export type AdminColumnKind =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  /** A point in time. Carries a timezone-sensitive time component. */
  | "date"
  /** A calendar day with no time component, and so no timezone. */
  | "date-only"
  | "json"
  | "array"
  | "buffer"
  | "unknown";

/** Everything a generic client needs to render one column without knowing the schema. */
export type AdminColumnMeta = {
  name: string;
  /** PostgreSQL type, e.g. `varchar(256)` or `timestamp`. */
  sqlType: string;
  kind: AdminColumnKind;
  nullable: boolean;
  primaryKey: boolean;
  /** True when a unique constraint or unique index covers this column on its own. */
  unique: boolean;
  hasDefault: boolean;
  writable: boolean;
  /** Allowed values for enum and `text({ enum })` columns, otherwise null. */
  enumValues: string[] | null;
  /** Set when the column references another table, so clients can offer a link. */
  references: { table: string; column: string } | null;
};

export type AdminTableMeta = {
  name: string;
  exportName: string;
  columns: AdminColumnMeta[];
  /** Columns identifying one row. Empty means the table can only be read. */
  primaryKey: string[];
  /** Multi-column unique constraints, for clients that want to explain write failures. */
  uniqueConstraints: string[][];
  /** False when the table has no primary key, so rows can't be addressed for writes. */
  writable: boolean;
};

/**
 * Map a column onto the coarser kinds the dashboard cares about.
 *
 * Mostly a rename of Drizzle's `dataType`, with one deliberate exception: a `date`
 * column is reported as `date-only` regardless of the TS type Drizzle hands back for it.
 * `date()` yields a string and `date({ mode: "date" })` yields a `Date`, so `dataType`
 * alone would send the second down the timestamp path — and rendering a calendar day in
 * a timezone-aware widget drags it through the browser's offset, landing it on the
 * previous day anywhere west of UTC. The SQL type is the only reliable signal that
 * there's no time component to convert.
 */
function columnKind(column: PgColumn): AdminColumnKind {
  if (column.getSQLType() === "date") return "date-only";

  switch (column.dataType) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "date":
    case "json":
    case "array":
    case "buffer":
      return column.dataType;
    default:
      return "unknown";
  }
}

/**
 * Describe a table in a form a generic client can render: column types, nullability,
 * uniqueness, defaults, enum values, and foreign key targets.
 *
 * Single-column uniqueness merges three sources Drizzle tracks separately — the
 * column's own `.unique()`, table-level unique constraints, and unique indexes — so the
 * UI can flag a field as unique regardless of how the schema author declared it.
 *
 * Tables without a primary key are reported as read-only. Without one there's no safe
 * way to address a single row, and an admin tool that issues unbounded `UPDATE`s is a
 * loaded gun.
 *
 * @param exposed - Table resolved by `requireTable()`.
 * @returns Serializable table metadata, safe to return directly from an action.
 */
export function describeTable(exposed: ExposedTable): AdminTableMeta {
  const { foreignKeys, uniqueConstraints, indexes } = getTableConfig(
    exposed.table,
  );

  // The addressable key, not the declared one: a key a caller can't see is a key it
  // can't send back, so reporting it would advertise write actions that must fail.
  const primaryKey = addressableKeyColumns(exposed).map((c) => c.name);
  const writableNames = new Set(writableColumns(exposed).map((c) => c.name));

  const singleColumnUnique = new Set<string>();
  for (const constraint of uniqueConstraints) {
    if (constraint.columns.length === 1) {
      singleColumnUnique.add(constraint.columns[0].name);
    }
  }
  for (const index of indexes) {
    if (!index.config.unique) continue;
    const columns = index.config.columns;
    if (columns.length !== 1) continue;
    const only = columns[0];
    if ("name" in only && typeof only.name === "string") {
      singleColumnUnique.add(only.name);
    }
  }

  const references = new Map<string, { table: string; column: string }>();
  for (const foreignKey of foreignKeys) {
    const ref = foreignKey.reference();
    ref.columns.forEach((column, i) => {
      const target = ref.foreignColumns[i];
      if (!target) return;
      references.set(column.name, {
        table: getTableName(ref.foreignTable),
        column: target.name,
      });
    });
  }

  const columns: AdminColumnMeta[] = readableColumns(exposed).map((column) => ({
    name: column.name,
    sqlType: column.getSQLType(),
    kind: columnKind(column),
    nullable: !column.notNull,
    primaryKey: primaryKey.includes(column.name),
    unique: column.isUnique || singleColumnUnique.has(column.name),
    hasDefault: column.hasDefault,
    writable: writableNames.has(column.name),
    enumValues: column.enumValues ? [...column.enumValues] : null,
    references: references.get(column.name) ?? null,
  }));

  return {
    name: exposed.name,
    exportName: exposed.exportName,
    columns,
    primaryKey,
    uniqueConstraints: uniqueConstraints
      .map((c) => c.columns.map((col) => col.name))
      .filter((cols) => cols.length > 1),
    writable: primaryKey.length > 0,
  };
}
