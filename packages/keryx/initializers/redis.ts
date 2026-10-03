import type { EventEmitter } from "events";
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
 * The parts of an `ioredis-mock` instance's private, process-wide shared state that the
 * expiry sweeper relies on. `data.has()` deletes a key whose TTL has passed, and
 * `modifiedKeyEvents` fires with the full key name on every write. These are internals
 * of ioredis-mock 8.x; `__tests__/standalone.test.ts` covers them so an
 * upgrade that changes them fails loudly.
 */
type MemoryRedisContext = {
  data: { has(key: string): boolean };
  modifiedKeyEvents: EventEmitter;
};

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
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private trackedKeys = new Set<string>();
  private memoryContext: MemoryRedisContext | undefined;
  private trackKey = (key: string) => {
    this.trackedKeys.add(key);
  };

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
      this.startExpirySweeper(api.redis.redis);
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
    this.stopExpirySweeper();
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

  /**
   * ioredis-mock only removes an expired key when that key is read again, so keys that
   * are written with a TTL and then abandoned (rate-limit windows, expired sessions,
   * OAuth codes) would accumulate forever in a long-running process. Track every key
   * that is written and periodically probe them, which deletes the expired ones.
   */
  private startExpirySweeper(client: RedisClient) {
    // @ts-expect-error -- `context` is ioredis-mock's private shared state; see MemoryRedisContext
    const memoryContext = client.context as MemoryRedisContext | undefined;
    if (!memoryContext?.modifiedKeyEvents || !memoryContext.data) {
      logger.warn(
        "in-memory redis: cannot find ioredis-mock internals, expired keys will only be removed when read",
      );
      return;
    }

    this.memoryContext = memoryContext;
    memoryContext.modifiedKeyEvents.on("modified", this.trackKey);
    this.sweepTimer = setInterval(
      () => this.sweepExpiredKeys(),
      config.redis.memorySweepIntervalMs,
    );
    this.sweepTimer.unref?.();
  }

  /**
   * Delete every tracked key whose TTL has passed. Called on an interval while the
   * in-memory Redis is active; also safe to call directly.
   *
   * @returns The number of keys that no longer exist (expired or deleted) and were
   * dropped from tracking.
   */
  sweepExpiredKeys() {
    const context = this.memoryContext;
    if (!context) return 0;

    let removed = 0;
    for (const key of this.trackedKeys) {
      // `has()` deletes the key as a side effect when it has expired.
      if (!context.data.has(key)) {
        this.trackedKeys.delete(key);
        removed++;
      }
    }
    return removed;
  }

  private stopExpirySweeper() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.memoryContext?.modifiedKeyEvents.off("modified", this.trackKey);
    this.memoryContext = undefined;
    this.trackedKeys.clear();
  }
}
