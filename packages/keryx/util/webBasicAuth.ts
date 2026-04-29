import { safeCompare } from "./safeCompare";

/**
 * Verifies an HTTP Basic auth `Authorization` header against expected credentials
 * using a constant-time string compare.
 *
 * @param req - The incoming `Request`. Read for its `Authorization` header.
 * @param expectedUsername - The username to match. If empty, auth is treated as
 *   disabled and the function returns `true`.
 * @param expectedPassword - The password to match. If empty, auth is treated as
 *   disabled and the function returns `true`.
 * @returns `true` when auth is disabled (either credential empty) or when the
 *   header carries valid `Basic <base64>` credentials matching both expected
 *   values. `false` for any malformed, missing, or wrong header.
 */
export function verifyBasicAuth(
  req: Request,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  if (!expectedUsername || !expectedPassword) return true;

  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }

  const idx = decoded.indexOf(":");
  if (idx === -1) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  const userOk = safeCompare(user, expectedUsername);
  const passOk = safeCompare(pass, expectedPassword);
  return userOk && passOk;
}
