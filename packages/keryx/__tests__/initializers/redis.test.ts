import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Redis as RedisClient } from "ioredis";
import { api } from "../../api";
import { config } from "../../config";
import { Redis } from "../../initializers/redis";
import { HOOK_TIMEOUT } from "../setup";

beforeAll(async () => {
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("Redis initializer", () => {
  test("declares documented load/start/stop priorities", () => {
    const r = new Redis();
    expect(r.loadPriority).toBe(200);
    expect(r.startPriority).toBe(110);
    expect(r.stopPriority).toBe(990);
  });

  test("exposes two live ioredis clients on api.redis", () => {
    expect(api.redis.redis).toBeInstanceOf(RedisClient);
    expect(api.redis.subscription).toBeInstanceOf(RedisClient);
  });

  test("primary client answers PING with PONG", async () => {
    // Only the primary client can issue arbitrary commands — the `subscription`
    // client is in subscriber mode (owned by the pubsub initializer).
    expect(await api.redis.redis.ping()).toBe("PONG");
  });

  test("round-trips a key through the primary client", async () => {
    const key = `__keryx_redis_test_rt:${crypto.randomUUID()}`;
    try {
      await api.redis.redis.set(key, "hello");
      expect(await api.redis.redis.get(key)).toBe("hello");
    } finally {
      await api.redis.redis.del(key);
    }
  });

  test("primary client supports INCR (atomic command)", async () => {
    const key = `__keryx_redis_test_incr:${crypto.randomUUID()}`;
    try {
      expect(await api.redis.redis.incr(key)).toBe(1);
      expect(await api.redis.redis.incr(key)).toBe(2);
    } finally {
      await api.redis.redis.del(key);
    }
  });

  test("pub/sub delivery works between two fresh clients on the same server", async () => {
    // Use a dedicated subscriber rather than api.redis.subscription, which is
    // owned by the pubsub initializer and already wired to a message handler
    // that expects JSON payloads.
    const subscriber = new RedisClient(config.redis.connectionString);
    const publisher = api.redis.redis;
    const channel = `__keryx_redis_test_pubsub:${crypto.randomUUID()}`;

    try {
      const received = new Promise<string>((resolve) => {
        subscriber.on("message", (ch: string, msg: string) => {
          if (ch === channel) resolve(msg);
        });
      });

      await subscriber.subscribe(channel);
      await publisher.publish(channel, "hi");
      expect(await received).toBe("hi");
    } finally {
      await subscriber.quit();
    }
  });

  test("stop() is a no-op when no connections exist on the initializer", async () => {
    // Verifies the `if (api.redis.redis) { ... }` guard in Redis.stop() —
    // calling stop() without having started doesn't throw.
    const standalone = new Redis();
    const liveRedis = api.redis;
    (api as any).redis = { redis: undefined, subscription: undefined };
    try {
      await expect(standalone.stop()).resolves.toBeUndefined();
    } finally {
      (api as any).redis = liveRedis;
    }
  });
});
