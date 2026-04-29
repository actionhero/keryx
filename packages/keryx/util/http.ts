import { config } from "../config";

/**
 * Check whether a request origin is permitted by the configured allowed-origins list.
 */
export function isOriginAllowed(origin: string): boolean {
  const allowedOrigins = config.server.web.allowedOrigins;
  if (allowedOrigins === "*") return true;
  const allowed = allowedOrigins.split(",").map((o) => o.trim());
  return allowed.includes(origin);
}

/**
 * Build CORS headers for a response.
 *
 * @param requestOrigin - The `Origin` header from the incoming request (if any).
 * @param extra - Additional CORS headers to merge (e.g. `Access-Control-Allow-Methods`).
 *                Any key not already set will be added.
 */
export function buildCorsHeaders(
  requestOrigin: string | undefined,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const allowedOrigins = config.server.web.allowedOrigins;

  if (allowedOrigins === "*" && !requestOrigin) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (requestOrigin && isOriginAllowed(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
    headers["Vary"] = "Origin";
  }

  return headers;
}

/**
 * Derive the external-facing origin for a request. Used to construct OAuth
 * metadata URLs (issuer, endpoints) and the MCP `WWW-Authenticate` resource
 * metadata URL.
 *
 * Resolution order:
 * 1. `applicationUrl` config (when set to a non-localhost value).
 * 2. `X-Forwarded-Proto` / `X-Forwarded-Host` (or `Host`) headers — only when
 *    `config.server.mcp.oauthTrustProxy` is enabled. These headers are
 *    spoofable by any client when the server is reachable directly, so
 *    trusting them unconditionally would let an attacker poison OAuth
 *    metadata and MCP `WWW-Authenticate` URLs. Operators must opt in via
 *    `MCP_OAUTH_TRUST_PROXY=true` after confirming a reverse proxy strips
 *    client-supplied forwarded headers.
 * 3. The parsed request-URL origin.
 */
export function getExternalOrigin(req: Request, url: URL): string {
  // Prefer explicitly configured APPLICATION_URL (for proxy/tunnel scenarios
  // where X-Forwarded-* headers may not be present)
  const appUrl = config.server.web.applicationUrl;
  if (appUrl && !appUrl.startsWith("http://localhost")) {
    return new URL(appUrl).origin;
  }

  if (config.server.mcp.oauthTrustProxy) {
    const forwardedProto = req.headers.get("x-forwarded-proto");
    const forwardedHost =
      req.headers.get("x-forwarded-host") || req.headers.get("host");

    if (forwardedProto && forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`;
    }

    if (forwardedHost) {
      return `${url.protocol}//${forwardedHost}`;
    }
  }

  return url.origin;
}

/**
 * Return a new `Response` with extra headers merged in.
 * Existing headers on the response are preserved (not overwritten).
 */
export function appendHeaders(
  response: Response,
  headers: Record<string, string>,
): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) {
    if (!newHeaders.has(key)) {
      newHeaders.set(key, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
