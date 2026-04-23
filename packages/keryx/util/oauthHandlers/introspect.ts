import { api } from "../../api";
import { clientKey, tokenLookupOrder } from "./keys";
import { jsonNoStoreResponse, oauthError, parseFormBody } from "./responses";
import type { RefreshTokenData, TokenData } from "./types";

const NOSTORE_HEADER = { "Cache-Control": "no-store" };

/**
 * OAuth 2.0 Token Introspection endpoint (RFC 7662).
 *
 * Requires a registered `client_id` in the form body; unknown clients get 401
 * so random callers cannot probe token state. Looks up `token` in both the
 * access-token and refresh-token keyspaces (honoring `token_type_hint` for
 * lookup order). Returns `{ active: false }` for any miss so we do not leak
 * whether a token existed and expired versus never existed.
 */
export async function handleIntrospect(req: Request): Promise<Response> {
  const body = await parseFormBody(req);
  const token = body.get("token");
  const hint = body.get("token_type_hint");
  const clientId = body.get("client_id");

  if (!clientId) {
    return oauthError(
      "invalid_client",
      "client_id is required",
      401,
      NOSTORE_HEADER,
    );
  }

  const clientRaw = await api.redis.redis.get(clientKey(clientId));
  if (!clientRaw) {
    return oauthError("invalid_client", "Unknown client", 401, NOSTORE_HEADER);
  }

  if (!token) return jsonNoStoreResponse({ active: false });

  for (const key of tokenLookupOrder(token, hint)) {
    const raw = await api.redis.redis.get(key);
    if (!raw) continue;

    const data = JSON.parse(raw) as TokenData | RefreshTokenData;
    const ttlSeconds = await api.redis.redis.ttl(key);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const exp = ttlSeconds > 0 ? nowSeconds + ttlSeconds : undefined;

    return jsonNoStoreResponse({
      active: true,
      client_id: data.clientId,
      scope: data.scopes.join(" "),
      token_type: "Bearer",
      exp,
      sub: String(data.userId),
    });
  }

  return jsonNoStoreResponse({ active: false });
}
