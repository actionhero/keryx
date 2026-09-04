import type { PgColumn } from "drizzle-orm/pg-core";
import { ErrorType, TypedError } from "keryx";

/**
 * Convert a JSON value into something Drizzle can bind to a column.
 *
 * JSON has no date type and HTML forms submit everything as strings, so values arrive
 * loosely typed and need nudging toward the column's shape. This deliberately stays
 * minimal: it handles the conversions the driver can't (strings to `Date`, strings to
 * numbers) and passes everything else straight through so PostgreSQL does the real
 * validating. A too-long `varchar`, a malformed UUID, or a bad enum member should come
 * back as a database error with the constraint that rejected it — not as a guess made
 * here about what the caller meant.
 *
 * @param column - Target column, resolved from the schema rather than caller input.
 * @param value - Raw JSON value from request params.
 * @returns A value suitable for `insert().values()` or `update().set()`.
 * @throws {TypedError} With `ErrorType.CONNECTION_ACTION_RUN` when a value can't be
 * converted at all — a non-numeric string for a numeric column, or an unparseable date.
 * These are the cases where passing through would produce a confusing driver error.
 */
export function coerceValue(column: PgColumn, value: unknown): unknown {
  if (value === null) return null;

  // Empty form fields arrive as "" — meaningless for non-text columns, so treat
  // them as SQL NULL and let a NOT NULL constraint object if that's wrong.
  if (value === "" && column.dataType !== "string") return null;

  switch (column.dataType) {
    case "number": {
      if (typeof value === "number") return value;
      if (typeof value === "boolean") return value ? 1 : 0;
      if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isNaN(parsed)) {
          throw invalid(column, value, "a number");
        }
        return parsed;
      }
      return value;
    }

    case "bigint": {
      if (typeof value === "bigint") return value;
      if (typeof value === "number" || typeof value === "string") {
        try {
          return BigInt(value);
        } catch {
          throw invalid(column, value, "an integer");
        }
      }
      return value;
    }

    case "boolean": {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "t", "1", "yes", "on"].includes(normalized)) return true;
        if (["false", "f", "0", "no", "off"].includes(normalized)) return false;
        throw invalid(column, value, "a boolean");
      }
      if (typeof value === "number") return value !== 0;
      return value;
    }

    case "date": {
      if (value instanceof Date) return value;
      if (typeof value === "string" || typeof value === "number") {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw invalid(column, value, "a date");
        }
        return parsed;
      }
      return value;
    }

    case "json": {
      // Objects and arrays pass through; a string may be either raw JSON text from a
      // textarea or a plain string value, so only replace it when it parses.
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }

    case "string": {
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return value;
    }

    default:
      return value;
  }
}

function invalid(column: PgColumn, value: unknown, expected: string) {
  return new TypedError({
    message: `Column "${column.name}" expects ${expected}, received ${JSON.stringify(value)}`,
    type: ErrorType.CONNECTION_ACTION_RUN,
  });
}
