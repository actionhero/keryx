/**
 * Returns a warning message when the web server is configured to leak stack
 * traces to remote callers, otherwise `null`. Stack traces in error responses
 * leak deployment paths and code structure, which is fine on a developer's
 * laptop but a footgun on a publicly reachable host.
 */
export function shouldWarnStackLeak(
  host: string,
  includeStackInErrors: boolean,
): string | null {
  if (!includeStackInErrors) return null;
  const isLocalBind =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";
  if (isLocalBind) return null;
  return (
    `⚠️  Stack traces are enabled in error responses (host=${host}). ` +
    `This leaks internal paths and code structure. ` +
    `Set NODE_ENV=production or WEB_SERVER_INCLUDE_STACK_IN_ERRORS=false before exposing this server publicly.`
  );
}
