import { Redis as RedisClient } from "ioredis";
import { api, logger } from "../api";
import { Initializer } from "../classes/Initializer";
import { config } from "../config";

import {
  formatConnectionStringForLogging,
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
 */
export class Redis extends Initializer {
  constructor() {
    super(namespace);
  }

  async initialize() {
    const redisContainer = {} as {
      redis: RedisClient;
      subscription: RedisClient;
    };
    return redisContainer;
  }

  async start() {
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
