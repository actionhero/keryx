import { randomBytes } from "crypto";
import { api } from "keryx";
import { config } from "keryx/config";

type CsrfConfig = {
  tokenTtl: number;
  paramName: string;
  redisKeyPrefix: string;
};

/** Read the CSRF config block. The plugin merges defaults during init. */
export function csrfConfig(): CsrfConfig {
  return (config as unknown as { csrf: CsrfConfig }).csrf;
}

function tokenKey(sessionId: string): string {
  return `${csrfConfig().redisKeyPrefix}:${sessionId}`;
}

/**
 * Look up the CSRF token currently bound to a session.
 *
 * @param sessionId - The session identifier to read the token for.
 * @returns The stored token string, or `null` if none exists / has expired.
 */
export async function getToken(sessionId: string): Promise<string | null> {
  return api.redis.redis.get(tokenKey(sessionId));
}

/**
 * Issue a CSRF token for a session if none exists, otherwise return the
 * current one. In both cases the TTL is refreshed to `config.csrf.tokenTtl`.
 *
 * @param sessionId - The session identifier to issue a token for.
 * @returns The token string and the absolute Unix-seconds expiry timestamp.
 */
export async function ensureToken(
  sessionId: string,
): Promise<{ token: string; expiresAt: number }> {
  const key = tokenKey(sessionId);
  const ttl = csrfConfig().tokenTtl;

  const existing = await api.redis.redis.get(key);
  const token = existing ?? randomBytes(32).toString("base64url");
  await api.redis.redis.set(key, token, "EX", ttl);

  return { token, expiresAt: Math.floor(Date.now() / 1000) + ttl };
}
