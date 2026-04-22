import { api } from "../../api";
import { accessKey, refreshKey, tokenLookupOrder } from "./keys";
import { parseFormBody } from "./responses";
import type { RefreshTokenData, TokenData } from "./types";

const ok = () =>
  new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });

/**
 * OAuth 2.0 Token Revocation endpoint (RFC 7009).
 *
 * Always returns 200 (even for unknown tokens or client mismatches) so callers
 * cannot probe token state. When a token is found and the supplied `client_id`
 * matches, the paired access+refresh keys are deleted together.
 */
export async function handleRevoke(req: Request): Promise<Response> {
  const body = await parseFormBody(req);
  const token = body.get("token");
  const hint = body.get("token_type_hint");
  const clientId = body.get("client_id");

  if (!token || !clientId) return ok();

  const accessK = accessKey(token);
  for (const key of tokenLookupOrder(token, hint)) {
    const raw = await api.redis.redis.get(key);
    if (!raw) continue;

    const data = JSON.parse(raw) as TokenData | RefreshTokenData;
    if (data.clientId !== clientId) return ok();

    // Discriminate by which keyspace matched, not by data shape: a seeded
    // access token may legitimately omit `refreshToken`.
    const pairedKey =
      key === accessK
        ? (data as TokenData).refreshToken
          ? refreshKey((data as TokenData).refreshToken!)
          : null
        : accessKey((data as RefreshTokenData).accessToken);

    await api.redis.redis.del(...(pairedKey ? [key, pairedKey] : [key]));
    return ok();
  }

  return ok();
}
