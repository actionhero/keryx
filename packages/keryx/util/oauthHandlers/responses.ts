const JSON_HEADERS = { "Content-Type": "application/json" };

/** Headers for endpoints that must not be cached (RFC 7662 §4, RFC 7009 §2.2). */
const JSON_NOSTORE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

/** JSON response with status 200 by default. */
export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/** JSON response with `Cache-Control: no-store`. */
export function jsonNoStoreResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_NOSTORE_HEADERS,
  });
}

/** Standard OAuth error-shape response (`{ error, error_description }`). */
export function oauthError(
  code: string,
  description: string,
  status = 400,
  extraHeaders?: Record<string, string>,
): Response {
  return jsonResponse(
    { error: code, error_description: description },
    status,
    extraHeaders,
  );
}

/**
 * Parse a form-urlencoded body (with JSON fallback) into URLSearchParams.
 * OAuth endpoints accept both encodings for client convenience; RFC 6749
 * specifies form-urlencoded, but several libraries default to JSON.
 */
export async function parseFormBody(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await req.json();
    return new URLSearchParams(json as Record<string, string>);
  }
  const text = await req.text();
  return new URLSearchParams(text);
}
