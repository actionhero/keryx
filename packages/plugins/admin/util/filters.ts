import {
  and,
  between,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ErrorType, TypedError } from "keryx";
import { z } from "zod";
import { coerceValue } from "./coerce";
import { type ExposedTable, requireColumn } from "./registry";

/** Comparison operators a filter condition may use. */
export const ADMIN_FILTER_OPERATORS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "like",
  "ilike",
  "contains",
  "startsWith",
  "endsWith",
  "in",
  "notIn",
  "isNull",
  "isNotNull",
  "between",
] as const;

export type AdminFilterOperator = (typeof ADMIN_FILTER_OPERATORS)[number];

export type AdminFilterCondition = {
  column: string;
  op: AdminFilterOperator;
  value?: unknown;
};

/**
 * A filter tree. Leaves compare one column; branches combine other filters with
 * `and`, `or`, or `not`, so arbitrarily nested boolean logic is expressible.
 */
export type AdminFilter =
  | AdminFilterCondition
  | { and: AdminFilter[] }
  | { or: AdminFilter[] }
  | { not: AdminFilter };

const conditionSchema = z.object({
  column: z.string().min(1),
  op: z.enum(ADMIN_FILTER_OPERATORS),
  value: z.unknown().optional(),
});

/**
 * Zod schema for the filter tree. Recursive via `z.lazy()`, and ordered so leaf
 * conditions are tried before branches — a branch object has no `column`/`op`, so it
 * falls through to the combinator members.
 */
export const adminFilterSchema: z.ZodType<AdminFilter> = z.lazy(() =>
  z.union([
    conditionSchema,
    z.object({ and: z.array(adminFilterSchema).min(1) }),
    z.object({ or: z.array(adminFilterSchema).min(1) }),
    z.object({ not: adminFilterSchema }),
  ]),
);

/** Escape LIKE metacharacters so a user's literal text can't act as a wildcard. */
function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function requireValue(condition: AdminFilterCondition) {
  if (condition.value === undefined) {
    throw new TypedError({
      message: `Filter operator "${condition.op}" on column "${condition.column}" requires a value`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  return condition.value;
}

function textOperand(condition: AdminFilterCondition) {
  const value = requireValue(condition);
  if (typeof value !== "string") {
    throw new TypedError({
      message: `Filter operator "${condition.op}" on column "${condition.column}" requires a string value`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  return value;
}

/**
 * Drizzle's comparison helpers infer their operand type from the column's generic
 * parameters. Columns resolved from `api.db.schema` at runtime are plain `PgColumn`,
 * so there is no static type to infer from and the operand lands as `never`. The
 * values are still bound as query parameters by the driver, never interpolated.
 */
type Operand = Parameters<typeof eq<PgColumn>>[1];

function compileCondition(
  exposed: ExposedTable,
  condition: AdminFilterCondition,
): SQL {
  const column = requireColumn(exposed, condition.column);
  const coerce = (value: unknown) => coerceValue(column, value) as Operand;

  switch (condition.op) {
    case "eq": {
      // A null equality test has to become IS NULL; `= NULL` matches nothing.
      const value = requireValue(condition);
      return value === null ? isNull(column) : eq(column, coerce(value));
    }
    case "neq": {
      const value = requireValue(condition);
      return value === null ? isNotNull(column) : ne(column, coerce(value));
    }
    case "lt":
      return lt(column, coerce(requireValue(condition)));
    case "lte":
      return lte(column, coerce(requireValue(condition)));
    case "gt":
      return gt(column, coerce(requireValue(condition)));
    case "gte":
      return gte(column, coerce(requireValue(condition)));

    // `like`/`ilike` pass the pattern through so callers can use wildcards on purpose.
    case "like":
      return like(column, textOperand(condition));
    case "ilike":
      return ilike(column, textOperand(condition));

    // The substring operators escape wildcards, so typing "50%" in a search box
    // searches for the literal text rather than matching everything.
    case "contains":
      return ilike(column, `%${escapeLikePattern(textOperand(condition))}%`);
    case "startsWith":
      return ilike(column, `${escapeLikePattern(textOperand(condition))}%`);
    case "endsWith":
      return ilike(column, `%${escapeLikePattern(textOperand(condition))}`);

    case "in":
    case "notIn": {
      const value = requireValue(condition);
      if (!Array.isArray(value) || value.length === 0) {
        throw new TypedError({
          message: `Filter operator "${condition.op}" on column "${condition.column}" requires a non-empty array`,
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
      const values = value.map(coerce);
      return condition.op === "in"
        ? inArray(column, values)
        : notInArray(column, values);
    }

    case "isNull":
      return isNull(column);
    case "isNotNull":
      return isNotNull(column);

    case "between": {
      const value = requireValue(condition);
      if (!Array.isArray(value) || value.length !== 2) {
        throw new TypedError({
          message: `Filter operator "between" on column "${condition.column}" requires a [min, max] array`,
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
      return between(column, coerce(value[0]), coerce(value[1]));
    }
  }
}

/**
 * Compile a filter tree into a Drizzle `WHERE` clause.
 *
 * Column names are resolved against the table's real columns before any SQL is built,
 * so an unknown or hidden column fails loudly instead of reaching the database. Values
 * become bound parameters, never string-interpolated SQL.
 *
 * @param exposed - Table resolved by `requireTable()`.
 * @param filter - Filter tree, already validated by {@link adminFilterSchema}.
 * @returns A `WHERE` clause, or `undefined` when the tree contributes no conditions.
 * @throws {TypedError} With `ErrorType.CONNECTION_ACTION_RUN` for unknown columns or
 * operands that don't fit the operator.
 */
export function compileFilter(
  exposed: ExposedTable,
  filter: AdminFilter | undefined,
): SQL | undefined {
  if (!filter) return undefined;

  if ("and" in filter) {
    return and(...filter.and.map((f) => compileFilter(exposed, f)));
  }

  if ("or" in filter) {
    return or(...filter.or.map((f) => compileFilter(exposed, f)));
  }

  if ("not" in filter) {
    const inner = compileFilter(exposed, filter.not);
    return inner ? not(inner) : undefined;
  }

  return compileCondition(exposed, filter);
}
