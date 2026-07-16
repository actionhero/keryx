/**
 * Schemes that must never be accepted as redirect URIs. They can execute code or
 * read local resources if a client (or the browser) ever navigates to them, so
 * we reject them outright even though `/oauth/register` is open (RFC 7591).
 */
const DANGEROUS_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
]);

/**
 * Validate an OAuth redirect URI. Rules by scheme:
 * - `https:` — allowed for any host (remote web callbacks).
 * - `http:` — allowed only for loopback hosts (`localhost`, `127.0.0.1`, `[::1]`).
 * - `javascript:` / `data:` / `vbscript:` / `file:` — always rejected.
 * - any other scheme — treated as a private-use / custom URI scheme for a native
 *   app (e.g. `vscode://`, `cursor://`, `com.example.app:/callback`) and allowed
 *   per RFC 8252 §7.1. Reverse-DNS form is not required, since real clients
 *   (`vscode://`) don't use it.
 *
 * Fragments and userinfo are rejected for every scheme.
 *
 * @param uri - The redirect URI to validate.
 * @returns `{ valid: true }` or `{ valid: false, error: string }`.
 */
export function validateRedirectUri(uri: string): {
  valid: boolean;
  error?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { valid: false, error: `Invalid URI: ${uri}` };
  }

  if (parsed.hash) {
    return { valid: false, error: "Redirect URI must not contain a fragment" };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: "Redirect URI must not contain userinfo" };
  }

  if (DANGEROUS_SCHEMES.has(parsed.protocol)) {
    return {
      valid: false,
      error: `Redirect URI scheme "${parsed.protocol}" is not allowed`,
    };
  }

  if (parsed.protocol === "http:") {
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
    if (!isLoopback) {
      return {
        valid: false,
        error: "Redirect URI must use HTTPS for non-localhost URIs",
      };
    }
  }

  // https: and private-use/custom schemes (native apps) are allowed.
  return { valid: true };
}

/**
 * Compare two redirect URIs with exact string matching, as required by
 * RFC 6749 §3.1.2.3 and RFC 8252 §8.4.
 */
export function redirectUrisMatch(
  registeredUri: string,
  requestedUri: string,
): boolean {
  return registeredUri === requestedUri;
}

/** Encode a byte array as a URL-safe base64 string (no padding). Used for PKCE code challenges. */
export function base64UrlEncode(buffer: Uint8Array): string {
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Escape a string for safe inclusion in HTML output (prevents XSS). */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
