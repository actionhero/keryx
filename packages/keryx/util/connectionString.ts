import { ErrorType, TypedError } from "../classes/TypedError";

/** Strip the password from a connection string for safe logging. Preserves protocol, user, host, port, and path. */
export function formatConnectionStringForLogging(connectionString: string) {
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
