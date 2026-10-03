import { ErrorType, TypedError } from "../classes/TypedError";

/**
 * Whether a Redis connection string selects the in-process, in-memory Redis
 * (`ioredis-mock`) instead of a real server. Any URL with the `memory:` scheme
 * qualifies, e.g. `memory://`.
 *
 * @param connectionString - The configured `REDIS_URL`.
 * @returns `true` for `memory:` URLs.
 */
export function isMemoryRedis(connectionString: string) {
  return connectionString.trim().toLowerCase().startsWith("memory:");
}

/**
 * Whether a database connection string turns the database off. An empty string
 * or the literal `"none"` (case-insensitive) means "run without Postgres".
 *
 * @param connectionString - The configured `DATABASE_URL`.
 * @returns `true` when no database should be connected.
 */
export function isDatabaseDisabled(connectionString: string) {
  const value = connectionString.trim().toLowerCase();
  return value === "" || value === "none";
}

/** Strip the password from a connection string for safe logging. Preserves protocol, user, host, port, and path. Unparseable strings are returned as `"(invalid connection string)"`. */
export function formatConnectionStringForLogging(connectionString: string) {
  if (!URL.canParse(connectionString)) return "(invalid connection string)";
  const connectionStringParsed = new URL(connectionString);
  const connectionStringInfo = `${connectionStringParsed.protocol ? `${connectionStringParsed.protocol}//` : ""}${connectionStringParsed.username ? `${connectionStringParsed.username}@` : ""}${connectionStringParsed.hostname}:${connectionStringParsed.port}${connectionStringParsed.pathname}`;
  return connectionStringInfo;
}

/** Throw a standardized `SERVER_INITIALIZATION` error for a failed connection probe. The connection string is password-stripped via {@link formatConnectionStringForLogging} before being embedded in the message. */
export function throwConnectionError(
  service: string,
  connectionString: string,
  error: unknown,
): never {
  throw new TypedError({
    type: ErrorType.SERVER_INITIALIZATION,
    message: `Cannot connect to ${service} (${formatConnectionStringForLogging(connectionString)}): ${error}`,
  });
}
