import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time UTF-8 string comparison. Pads both inputs to a common length
 * before delegating to `crypto.timingSafeEqual` so the comparison time does
 * not leak the expected length via early-return, then verifies the original
 * lengths matched. Use this whenever you compare a user-supplied secret
 * (password, API key, CSRF token, signed cookie value, …) against an expected
 * value — naive `===` leaks bytes via short-circuit timing.
 *
 * @param a - First string.
 * @param b - Second string.
 * @returns `true` when the strings are byte-identical, `false` otherwise.
 */
export function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  const len = Math.max(aBuf.length, bBuf.length, 1);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  aBuf.copy(aPadded);
  bBuf.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded) && aBuf.length === bBuf.length;
}
