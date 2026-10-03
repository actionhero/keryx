import { loadFromEnvIfSet } from "../util/config";

export const configRateLimit = {
  enabled: await loadFromEnvIfSet(
    "RATE_LIMIT_ENABLED",
    Bun.env.NODE_ENV === "test" ? false : true,
  ),
  windowMs: await loadFromEnvIfSet("RATE_LIMIT_WINDOW_MS", 60_000), // 60 seconds
  unauthenticatedLimit: await loadFromEnvIfSet("RATE_LIMIT_UNAUTH_LIMIT", 20),
  authenticatedLimit: await loadFromEnvIfSet("RATE_LIMIT_AUTH_LIMIT", 200),
  keyPrefix: await loadFromEnvIfSet("RATE_LIMIT_KEY_PREFIX", "ratelimit"),
  /** Stricter limit for OAuth client registration (per IP per window). */
  oauthRegisterLimit: await loadFromEnvIfSet(
    "RATE_LIMIT_OAUTH_REGISTER_LIMIT",
    5,
  ),
  /** Window for OAuth registration rate limit (default: 1 hour). */
  oauthRegisterWindowMs: await loadFromEnvIfSet(
    "RATE_LIMIT_OAUTH_REGISTER_WINDOW_MS",
    3_600_000,
  ),
  /** Stricter limit on new anonymous MCP sessions (`initialize` without a token), per IP per window. */
  mcpAnonymousInitLimit: await loadFromEnvIfSet(
    "RATE_LIMIT_MCP_ANON_INIT_LIMIT",
    10,
  ),
  /** Window for the anonymous MCP session-creation rate limit (default: 1 minute). */
  mcpAnonymousInitWindowMs: await loadFromEnvIfSet(
    "RATE_LIMIT_MCP_ANON_INIT_WINDOW_MS",
    60_000,
  ),
};
