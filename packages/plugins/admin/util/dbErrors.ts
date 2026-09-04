import { ErrorType, TypedError } from "keryx";

/**
 * The subset of `pg`'s error shape worth surfacing. The driver attaches these fields
 * straight from the PostgreSQL wire protocol.
 */
type PostgresError = {
  code?: string;
  detail?: string;
  constraint?: string;
  column?: string;
  table?: string;
  message?: string;
};

function isPostgresError(error: unknown): error is PostgresError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

/**
 * Find the driver error inside whatever Drizzle threw.
 *
 * Drizzle wraps failures in a `DrizzleQueryError` whose message is the full SQL text and
 * bound parameters, with the real `pg` error hanging off `cause`. Walking the chain
 * matters twice over: it's the only way to reach the `SQLSTATE` code, and it keeps the
 * wrapper's message — which embeds the query and every parameter value — out of the HTTP
 * response.
 *
 * @param error - The thrown value.
 * @returns The first error in the cause chain carrying a PostgreSQL code, or undefined.
 */
function findPostgresError(error: unknown): PostgresError | undefined {
  // A handful of links is plenty; the guard is against a cause cycle, not depth.
  let current = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (isPostgresError(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Translate a PostgreSQL error into a readable `TypedError`.
 *
 * The dashboard deliberately does not re-implement the schema's rules in application
 * code. Unique indexes, foreign keys, NOT NULL, CHECK constraints, and type coercion
 * already live in the database, and the database is the only place they can't drift out
 * of sync with reality. So writes are attempted optimistically and failures translated
 * here, which means a constraint added by a migration is enforced by the dashboard the
 * moment it exists — no plugin change required.
 *
 * @param error - Whatever the Drizzle call threw.
 * @param context - What the caller was doing, e.g. `create row in "users"`, used to
 * prefix messages that would otherwise lack a subject.
 * @returns A `TypedError` naming the offending constraint or column when PostgreSQL
 * reported one. Non-database errors are returned unchanged so real bugs still surface
 * with their original stack.
 */
export function toActionError(error: unknown, context: string): unknown {
  const pgError = findPostgresError(error);
  if (!pgError) return error;

  const target = pgError.constraint
    ? ` (constraint "${pgError.constraint}")`
    : pgError.column
      ? ` (column "${pgError.column}")`
      : "";
  const detail = pgError.detail ? ` ${pgError.detail}` : "";

  const message = (summary: string) =>
    new TypedError({
      message: `${context}: ${summary}${target}.${detail}`,
      type: ErrorType.CONNECTION_ACTION_RUN,
      cause: error,
    });

  switch (pgError.code) {
    case "23505":
      return message("a row with these values already exists");
    case "23503":
      return message("referenced row does not exist, or is still referenced");
    case "23502":
      return message("a required value is missing");
    case "23514":
      return message("a check constraint rejected these values");
    case "22P02":
      return message("a value has the wrong type for its column");
    case "22001":
      return message("a value is too long for its column");
    case "22003":
      return message("a numeric value is out of range for its column");
    case "22007":
    case "22008":
      return message("a date or time value could not be parsed");
    case "42703":
      return message("no such column");
    default:
      return error;
  }
}
