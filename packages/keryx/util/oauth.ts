/**
 * Validate an OAuth redirect URI per RFC 6749 / OAuth 2.1 rules:
 * no fragments, no userinfo, and HTTPS required for non-localhost URIs.
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

  const isLocalhost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";

  if (!isLocalhost && parsed.protocol !== "https:") {
    return {
      valid: false,
      error: "Redirect URI must use HTTPS for non-localhost URIs",
    };
  }

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
