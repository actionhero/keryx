import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "../../api";
import { CONNECTION_TYPE, Connection } from "../../classes/Connection";
import { ErrorType, TypedError } from "../../classes/TypedError";
import { config } from "../../config";
import {
  checkRateLimit,
  RateLimitMiddleware,
} from "../../middleware/rateLimit";
import { HOOK_TIMEOUT } from "../setup";

beforeAll(async () => {
  await api.start();
  await api.db.clearDatabase();
  // Enable rate limiting for this test file (disabled by default in test env)
  (config.rateLimit as any).enabled = true;
}, HOOK_TIMEOUT);

afterAll(async () => {
  // Disable rate limiting and clear keys so subsequent test files aren't throttled
  (config.rateLimit as any).enabled = false;
  const keys = await api.redis.redis.keys(`${config.rateLimit.keyPrefix}:*`);
  if (keys.length > 0) await api.redis.redis.del(...keys);
  await api.stop();
}, HOOK_TIMEOUT);

beforeEach(async () => {
  // Clear all rate limit keys
  const keys = await api.redis.redis.keys(`${config.rateLimit.keyPrefix}:*`);
  if (keys.length > 0) await api.redis.redis.del(...keys);
});

describe("RateLimitMiddleware", () => {
  describe("runBefore", () => {
    test("allows requests under the limit", async () => {
      const connection = new Connection(CONNECTION_TYPE.WEB, "10.0.0.1");
      connection.session = undefined;

      const result = await RateLimitMiddleware.runBefore!({}, connection);
      expect(result).toBeUndefined();

      const info = connection.rateLimitInfo!;
      expect(info).toBeDefined();
      expect(info.limit).toBe(config.rateLimit.unauthenticatedLimit);
      expect(info.remaining).toBeLessThan(info.limit);
      expect(info.retryAfter).toBeUndefined();

      connection.destroy();
    });

    test("throws TypedError when rate limit exceeded", async () => {
      const identifier = "ip:10.0.0.2";
      const limit = config.rateLimit.unauthenticatedLimit;

      // Exhaust the rate limit
      const pipeline = api.redis.redis.pipeline();
      const windowMs = config.rateLimit.windowMs;
      const currentWindow = Math.floor(Date.now() / windowMs);
      const key = `${config.rateLimit.keyPrefix}:${identifier}:${currentWindow}`;
      pipeline.set(key, String(limit + 10));
      pipeline.expire(key, 120);
      await pipeline.exec();

      const connection = new Connection(CONNECTION_TYPE.WEB, "10.0.0.2");
      connection.session = undefined;

      try {
        await RateLimitMiddleware.runBefore!({}, connection);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBeInstanceOf(TypedError);
        expect((e as TypedError).type).toBe(ErrorType.CONNECTION_RATE_LIMITED);
        expect((e as TypedError).message).toContain("Rate limit exceeded");
      }

      connection.destroy();
    });

    test("authenticated users get the authenticated limit", async () => {
      // Temporarily set different limits to verify the correct one is chosen
      const origUnauth = config.rateLimit.unauthenticatedLimit;
      const origAuth = config.rateLimit.authenticatedLimit;
      (config.rateLimit as any).unauthenticatedLimit = 5;
      (config.rateLimit as any).authenticatedLimit = 50;

      try {
        const unauthConn = new Connection(CONNECTION_TYPE.WEB, "10.0.0.30");
        unauthConn.session = undefined;
        await RateLimitMiddleware.runBefore!({}, unauthConn);
        const unauthInfo = (unauthConn as any).rateLimitInfo!;
        expect(unauthInfo.limit).toBe(5);
        unauthConn.destroy();

        const authConn = new Connection(CONNECTION_TYPE.WEB, "10.0.0.31");
        authConn.session = {
          id: "test-session",
          cookieName: "sessionId",
          createdAt: Date.now(),
          data: { userId: 42 },
        };
        await RateLimitMiddleware.runBefore!({}, authConn);
        const authInfo = (authConn as any).rateLimitInfo!;
        expect(authInfo.limit).toBe(50);
        expect(authInfo.limit).toBeGreaterThan(unauthInfo.limit);
        authConn.destroy();
      } finally {
        (config.rateLimit as any).unauthenticatedLimit = origUnauth;
        (config.rateLimit as any).authenticatedLimit = origAuth;
      }
    });

    test("does nothing when rate limiting is disabled", async () => {
      const originalEnabled = config.rateLimit.enabled;
      (config.rateLimit as any).enabled = false;

      try {
        const connection = new Connection(CONNECTION_TYPE.WEB, "10.0.0.4");
        const result = await RateLimitMiddleware.runBefore!({}, connection);
        expect(result).toBeUndefined();
        expect(connection.rateLimitInfo).toBeUndefined();
        connection.destroy();
      } finally {
        (config.rateLimit as any).enabled = originalEnabled;
      }
    });
  });

  describe("checkRateLimit", () => {
    test("returns correct info under limit", async () => {
      const info = await checkRateLimit("ip:10.0.0.10", false);
      expect(info.limit).toBe(config.rateLimit.unauthenticatedLimit);
      expect(info.remaining).toBeLessThanOrEqual(info.limit);
      expect(info.remaining).toBeGreaterThanOrEqual(0);
      expect(info.resetAt).toBeGreaterThan(0);
      expect(info.retryAfter).toBeUndefined();
    });

    test("returns retryAfter when over limit", async () => {
      const windowMs = config.rateLimit.windowMs;
      const currentWindow = Math.floor(Date.now() / windowMs);
      const key = `${config.rateLimit.keyPrefix}:ip:10.0.0.11:${currentWindow}`;
      await api.redis.redis.set(
        key,
        String(config.rateLimit.unauthenticatedLimit + 10),
      );

      const info = await checkRateLimit("ip:10.0.0.11", false);
      expect(info.remaining).toBe(0);
      expect(info.retryAfter).toBeDefined();
      expect(info.retryAfter).toBeGreaterThan(0);
    });

    test("different identifiers have independent limits", async () => {
      // Exhaust limit for one IP
      const windowMs = config.rateLimit.windowMs;
      const currentWindow = Math.floor(Date.now() / windowMs);
      const key = `${config.rateLimit.keyPrefix}:ip:10.0.0.12:${currentWindow}`;
      await api.redis.redis.set(
        key,
        String(config.rateLimit.unauthenticatedLimit + 10),
      );

      // Different IP should still be fine
      const info = await checkRateLimit("ip:10.0.0.13", false);
      expect(info.retryAfter).toBeUndefined();

      // Original IP should be limited
      const limitedInfo = await checkRateLimit("ip:10.0.0.12", false);
      expect(limitedInfo.retryAfter).toBeDefined();
    });
  });
});
