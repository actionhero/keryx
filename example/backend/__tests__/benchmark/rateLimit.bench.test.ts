import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  api,
  CONNECTION_TYPE,
  Connection,
  checkRateLimit,
  config,
  ErrorType,
  RateLimitMiddleware,
  TypedError,
} from "keryx";
import { HOOK_TIMEOUT } from "../setup";
import { computeStats, printStats } from "./stats";

// ---------------------------------------------------------------------------
// Stress thresholds — generous for CI variance.
// ---------------------------------------------------------------------------
const STRESS = {
  concurrentHits: 1_000,
  isolationIdentifiers: 10,
  isolationHitsPerIdentifier: 20,
  // Wall-clock cap on the concurrent-call burst. Tuned generously for
  // GitHub Actions runners; tighten if local p95 stays well under.
  burstP95Ms: 5_000,
  // Per-call latency (no contention, fresh window, high limit so the throw
  // path is never taken).
  perCallIterations: 1_000,
  perCallWarmup: 10,
  perCallP95Ms: 25,
};

// ---------------------------------------------------------------------------
// Bucket helper
// ---------------------------------------------------------------------------
type Outcome = "allowed" | "denied" | "unexpected";

function bucket(
  results: PromiseSettledResult<unknown>[],
): Record<Outcome, number> {
  const counts: Record<Outcome, number> = {
    allowed: 0,
    denied: 0,
    unexpected: 0,
  };
  for (const r of results) {
    if (r.status === "fulfilled") {
      counts.allowed++;
      continue;
    }
    if (
      r.reason instanceof TypedError &&
      r.reason.type === ErrorType.CONNECTION_RATE_LIMITED
    ) {
      counts.denied++;
      continue;
    }
    counts.unexpected++;
  }
  return counts;
}

async function flushRateLimitKeys() {
  const keys = await api.redis.redis.keys(`${config.rateLimit.keyPrefix}:*`);
  if (keys.length > 0) await api.redis.redis.del(...keys);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("rateLimit stress benchmarks", () => {
  let originalEnabled: boolean;

  beforeAll(async () => {
    originalEnabled = config.rateLimit.enabled;
    config.rateLimit.enabled = true;
    await api.start();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await flushRateLimitKeys();
    config.rateLimit.enabled = originalEnabled;
    await api.stop();
  }, HOOK_TIMEOUT);

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  test(
    "benchmark: concurrent hits partition allowed/denied deterministically",
    async () => {
      const limit = config.rateLimit.unauthenticatedLimit;
      const total = STRESS.concurrentHits;

      const calls = Array.from({ length: total }, () => {
        const conn = new Connection(CONNECTION_TYPE.WEB, "10.0.0.99");
        conn.session = undefined;
        return RateLimitMiddleware.runBefore!({}, conn).finally(() => {
          conn.destroy();
        });
      });

      const start = performance.now();
      const settled = await Promise.allSettled(calls);
      const elapsed = performance.now() - start;

      const counts = bucket(settled);

      printStats(
        `rateLimit (${total} concurrent, single identifier)`,
        computeStats([elapsed]),
        STRESS.burstP95Ms,
      );

      expect(counts.unexpected).toBe(0);
      expect(counts.allowed).toBe(limit);
      expect(counts.denied).toBe(total - limit);
      expect(counts.allowed + counts.denied).toBe(total);
      expect(elapsed).toBeLessThanOrEqual(STRESS.burstP95Ms);
    },
    { timeout: 60_000 },
  );

  test(
    "benchmark: distinct identifiers stay isolated under concurrent load",
    async () => {
      const ids = Array.from(
        { length: STRESS.isolationIdentifiers },
        (_, i) => `10.0.1.${i + 1}`,
      );
      const perId = STRESS.isolationHitsPerIdentifier;

      const calls = ids.flatMap((ip) =>
        Array.from({ length: perId }, () => {
          const conn = new Connection(CONNECTION_TYPE.WEB, ip);
          conn.session = undefined;
          return RateLimitMiddleware.runBefore!({}, conn).finally(() => {
            conn.destroy();
          });
        }),
      );

      const settled = await Promise.allSettled(calls);
      const counts = bucket(settled);

      expect(counts.unexpected).toBe(0);
      expect(counts.denied).toBe(0);
      expect(counts.allowed).toBe(ids.length * perId);
    },
    { timeout: 60_000 },
  );

  test(
    "benchmark: checkRateLimit per-call latency",
    async () => {
      const overrides = {
        limit: 1_000_000,
        windowMs: 60_000,
        keyPrefix: "bench-rl",
      };
      const identifier = "ip:bench-latency";

      // Warmup
      for (let i = 0; i < STRESS.perCallWarmup; i++) {
        await checkRateLimit(identifier, false, overrides);
      }

      const durations: number[] = [];
      for (let i = 0; i < STRESS.perCallIterations; i++) {
        const start = performance.now();
        const info = await checkRateLimit(identifier, false, overrides);
        const elapsed = performance.now() - start;
        expect(info.retryAfter).toBeUndefined();
        durations.push(elapsed);
      }

      const stats = computeStats(durations);
      printStats("checkRateLimit() per-call", stats, STRESS.perCallP95Ms);
      expect(stats.p95).toBeLessThanOrEqual(STRESS.perCallP95Ms);

      // Cleanup the bench-rl prefix
      const keys = await api.redis.redis.keys(`${overrides.keyPrefix}:*`);
      if (keys.length > 0) await api.redis.redis.del(...keys);
    },
    { timeout: 60_000 },
  );
});
