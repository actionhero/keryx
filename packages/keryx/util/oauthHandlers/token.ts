import { randomUUID } from "crypto";
import { api } from "../../api";
import { config } from "../../config";
import { base64UrlEncode } from "../oauth";
import { accessKey, codeKey, refreshKey } from "./keys";
import { jsonResponse, oauthError, parseFormBody } from "./responses";
import type { AuthCode, RefreshTokenData, TokenData } from "./types";

/**
 * Mint a new access/refresh token pair, store both in Redis with
 * cross-references, and return them together with the access-token TTL.
 *
 * The cross-reference (access token's `refreshToken`, refresh token's
 * `accessToken`) lets `/oauth/revoke` and the `refresh_token` grant cascade the
 * deletion to both keys without a secondary index.
 */
async function issueTokenPair(
  userId: number,
  clientId: string,
  scopes: string[],
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const accessToken = randomUUID();
  const refreshToken = randomUUID();

  const tokenData: TokenData = { userId, clientId, scopes, refreshToken };
  const refreshData: RefreshTokenData = {
    userId,
    clientId,
    scopes,
    accessToken,
  };

  await api.redis.redis.set(
    accessKey(accessToken),
    JSON.stringify(tokenData),
    "EX",
    config.session.ttl,
  );
  await api.redis.redis.set(
    refreshKey(refreshToken),
    JSON.stringify(refreshData),
    "EX",
    config.server.mcp.oauthRefreshTtl,
  );

  return { accessToken, refreshToken, expiresIn: config.session.ttl };
}

function tokenResponse(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): Response {
  return jsonResponse({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: expiresIn,
  });
}

async function handleAuthorizationCodeGrant(
  body: URLSearchParams,
): Promise<Response> {
  const code = body.get("code");
  const codeVerifier = body.get("code_verifier");
  const redirectUri = body.get("redirect_uri");
  const clientId = body.get("client_id");

  if (!code || !codeVerifier) {
    return oauthError("invalid_request", "code and code_verifier are required");
  }

  const codeRaw = await api.redis.redis.get(codeKey(code));
  if (!codeRaw) {
    return oauthError("invalid_grant", "Invalid or expired authorization code");
  }

  const codeData = JSON.parse(codeRaw) as AuthCode;
  // Delete the code immediately (single use)
  await api.redis.redis.del(codeKey(code));

  if (clientId !== codeData.clientId) {
    return oauthError("invalid_grant", "client_id mismatch");
  }
  // RFC 6749 §4.1.3: redirect_uri was part of the authorize request (and
  // is always stored on the code), so it MUST also be supplied here and
  // match exactly. Enforcing this prevents auth-code injection attacks.
  if (!redirectUri || redirectUri !== codeData.redirectUri) {
    return oauthError("invalid_grant", "redirect_uri mismatch");
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const computedChallenge = base64UrlEncode(new Uint8Array(digest));
  if (computedChallenge !== codeData.codeChallenge) {
    return oauthError("invalid_grant", "PKCE verification failed");
  }

  const pair = await issueTokenPair(codeData.userId, codeData.clientId, []);
  return tokenResponse(pair.accessToken, pair.refreshToken, pair.expiresIn);
}

async function handleRefreshTokenGrant(
  body: URLSearchParams,
): Promise<Response> {
  const refreshToken = body.get("refresh_token");
  const clientId = body.get("client_id");

  if (!refreshToken) {
    return oauthError("invalid_request", "refresh_token is required");
  }

  const raw = await api.redis.redis.get(refreshKey(refreshToken));
  if (!raw) {
    return oauthError("invalid_grant", "Invalid or expired refresh token");
  }

  const stored = JSON.parse(raw) as RefreshTokenData;
  if (clientId !== stored.clientId) {
    return oauthError("invalid_grant", "client_id mismatch");
  }

  // Rotate: invalidate the old pair before issuing a new one. Deleting first
  // closes the replay window if the new-pair write fails partway through.
  await api.redis.redis.del(
    refreshKey(refreshToken),
    accessKey(stored.accessToken),
  );

  const pair = await issueTokenPair(
    stored.userId,
    stored.clientId,
    stored.scopes,
  );
  return tokenResponse(pair.accessToken, pair.refreshToken, pair.expiresIn);
}

/** OAuth token exchange endpoint (RFC 6749). */
export async function handleToken(req: Request): Promise<Response> {
  const body = await parseFormBody(req);
  const grantType = body.get("grant_type");

  if (grantType === "authorization_code")
    return handleAuthorizationCodeGrant(body);
  if (grantType === "refresh_token") return handleRefreshTokenGrant(body);

  return jsonResponse({ error: "unsupported_grant_type" }, 400);
}
