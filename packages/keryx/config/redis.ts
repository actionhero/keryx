import { loadFromEnvIfSet } from "../util/config";

export const configRedis = {
  connectionString: await loadFromEnvIfSet(
    "REDIS_URL",
    "redis://localhost:6379/0",
  ),
};
