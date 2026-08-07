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
 * Hostnames RFC 8252 treats as loopback redirect destinations. `new URL()` reports
 * IPv6 hostnames bracketed, so `[::1]` is stored in that form to compare directly
 * against `parsed.hostname`.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
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
 * Compare a registered redirect URI against a requested one. The comparison is exact
 * string matching, as required by RFC 6749 §3.1.2.3 and RFC 8252 §8.4, with a single
 * carve-out: for `http:` loopback URIs the **port is ignored**, because RFC 8252 §7.3
 * requires the authorization server to "allow any port to be specified at the time of
 * the request" — a native app takes an ephemeral loopback port from the OS when it
 * starts its callback listener, so it cannot register the port ahead of time. This is
 * what lets a CLI client that declares `http://localhost/callback` authorize with
 * `http://localhost:49152/callback`.
 *
 * Four properties keep the carve-out narrow:
 * - Both sides must be `http:`. Port flexibility is a loopback concession, so
 *   `https://example.com/cb` still does not match `https://example.com:8443/cb`.
 * - Hostnames must be equal, and loopback. `localhost` does not match `127.0.0.1`;
 *   RFC 8252 §8.3 treats those as distinct registrations.
 * - Path, query, fragment, and userinfo stay exact, so appending `?state=xyz` to a
 *   registered URI is still rejected.
 * - The port is loose in both directions — a registered `http://localhost:3000/cb`
 *   matches a requested `http://localhost:4000/cb`, since the RFC allows *any* port
 *   at request time.
 *
 * @param registeredUri - A redirect URI from the client record (or its Client ID
 *   Metadata Document).
 * @param requestedUri - The `redirect_uri` on the authorization request.
 * @returns `true` when the requested URI is authorized by the registered one.
 */
export function redirectUrisMatch(
  registeredUri: string,
  requestedUri: string,
): boolean {
  if (registeredUri === requestedUri) return true;

  let registered: URL;
  let requested: URL;
  try {
    registered = new URL(registeredUri);
    requested = new URL(requestedUri);
  } catch {
    return false;
  }

  if (registered.protocol !== "http:" || requested.protocol !== "http:") {
    return false;
  }
  if (registered.hostname !== requested.hostname) return false;
  if (!LOOPBACK_HOSTS.has(registered.hostname)) return false;

  return (
    registered.pathname === requested.pathname &&
    registered.search === requested.search &&
    registered.hash === requested.hash &&
    registered.username === requested.username &&
    registered.password === requested.password
  );
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
