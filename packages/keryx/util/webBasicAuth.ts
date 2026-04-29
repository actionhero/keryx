import { timingSafeEqual } from "node:crypto";

// Pads to a common length so we don't leak the expected length via early-return.
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  const len = Math.max(aBuf.length, bBuf.length, 1);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  aBuf.copy(aPadded);
  bBuf.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length;
}

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

  const userOk = timingSafeStringEqual(user, expectedUsername);
  const passOk = timingSafeStringEqual(pass, expectedPassword);
  return userOk && passOk;
}
