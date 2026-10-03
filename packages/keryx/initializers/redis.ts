import { Redis as RedisClient } from "ioredis";
import { api, logger } from "../api";
import { Initializer } from "../classes/Initializer";
import { config } from "../config";

import {
  formatConnectionStringForLogging,
  isMemoryRedis,
  throwConnectionError,
} from "../util/connectionString";

const namespace = "redis";
const testKey = `__keryx_test_key:${config.process.name}`;

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Redis["initialize"]>>;
  }
}

/**
 * Initializer that manages two Redis connections: `redis` for general commands and
 * `subscription` for PubSub. Both are created during `start()` and closed during `stop()`.
 * Exposes `api.redis.redis` and `api.redis.subscription` as ioredis `RedisClient` instances.
 *
 * When `REDIS_URL` uses the `memory:` scheme (e.g. `memory://`), both clients are
 * in-process `ioredis-mock` instances that share one dataset instead of connections to
 * a Redis server. Tasks, PubSub, presence, sessions and rate limiting all keep working,
 * but state lives only in this process: it is not shared with other processes and is
 * lost when the process exits. `api.redis.inMemory` reports which mode is active.
 */
export class Redis extends Initializer {
  constructor() {
    super(namespace);
  }

  async initialize() {
    const redisContainer = { inMemory: false } as {
      redis: RedisClient;
      subscription: RedisClient;
      /** `true` when `REDIS_URL` selected the in-process `memory://` Redis. */
      inMemory: boolean;
    };
    return redisContainer;
  }

  async start() {
    api.redis.inMemory = isMemoryRedis(config.redis.connectionString);

    if (api.redis.inMemory) {
      // Loaded on demand so apps using a real Redis never pay for ioredis-mock's Lua VM.
      const { default: RedisMock } = await import("ioredis-mock");
      api.redis.redis = new RedisMock();
      api.redis.subscription = new RedisMock();
      logger.warn(
        "using in-memory redis (REDIS_URL=memory://): state is kept in this process only, is not shared with other processes, and is lost on restart",
      );
      return;
    }

    api.redis.redis = new RedisClient(config.redis.connectionString);
    api.redis.subscription = new RedisClient(config.redis.connectionString);

    try {
      await api.redis.redis.set(testKey, Date.now());
      await api.redis.redis.del(testKey);
      await api.redis.subscription.set(testKey, Date.now());
      await api.redis.subscription.del(testKey);
    } catch (e) {
      throwConnectionError("redis", config.redis.connectionString, e);
    }

    logger.info(
      `redis connections established (${formatConnectionStringForLogging(config.redis.connectionString)})`,
    );
  }

  async stop() {
    let acted = false;

    if (api.redis.redis) {
      try {
        await api.redis.redis.quit();
        acted = true;
      } catch (e) {
        logger.error(`error closing redis connection: ${e}`);
      }
    }

    if (api.redis.subscription) {
      try {
        await api.redis.subscription.quit();
        acted = true;
      } catch (e) {
        logger.error(`error closing redis subscription connection: ${e}`);
      }
    }

    if (acted) logger.info("redis connections closed");
  }
}
