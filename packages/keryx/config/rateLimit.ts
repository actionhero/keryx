import { loadFromEnvIfSet } from "../util/config";

export const configRateLimit = {
  enabled: await loadFromEnvIfSet(
    "RATE_LIMIT_ENABLED",
    process.env.NODE_ENV === "test" ? false : true,
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
};
