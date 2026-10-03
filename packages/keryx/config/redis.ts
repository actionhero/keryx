import { loadFromEnvIfSet } from "../util/config";

export const configRedis = {
  connectionString: await loadFromEnvIfSet(
    "REDIS_URL",
    "redis://localhost:6379/0",
  ),
  /** How often the in-memory (`memory://`) Redis deletes keys whose TTL has passed. */
  memorySweepIntervalMs: await loadFromEnvIfSet(
    "REDIS_MEMORY_SWEEP_INTERVAL_MS",
    60_000,
  ),
};
