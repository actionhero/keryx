import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { api } from "../../api";
import { ErrorType, TypedError } from "../../classes/TypedError";
import { config } from "../../config";
import { DB } from "../../initializers/db";
import { HOOK_TIMEOUT } from "../setup";

beforeAll(async () => {
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("DB initializer", () => {
  test("declares no initializer dependencies", () => {
    const d = new DB();
    expect(d.dependsOn).toEqual([]);
  });

  test("exposes a Pool and a drizzle instance on api.db", () => {
    expect(api.db.pool).toBeInstanceOf(Pool);
    expect(api.db.db).toBeDefined();
    expect(typeof api.db.db.execute).toBe("function");
  });

  test("exposes clearDatabase and generateMigrations methods", () => {
    expect(typeof api.db.clearDatabase).toBe("function");
    expect(typeof api.db.generateMigrations).toBe("function");
  });

  test("round-trips SELECT NOW() through the raw pool", async () => {
    const result = await api.db.pool.query("SELECT NOW() as now");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].now).toBeInstanceOf(Date);
  });

  test("round-trips SELECT 1 through the drizzle instance", async () => {
    const result = await api.db.db.execute(sql`SELECT 1::int as one`);
    const rows = result.rows as unknown as Array<{ one: number }>;
    expect(rows[0].one).toBe(1);
  });

  test("pool handles concurrent queries", async () => {
    const queries = Array.from({ length: 5 }, () =>
      api.db.pool.query("SELECT pg_sleep(0), 1 as one"),
    );
    const results = await Promise.all(queries);
    for (const r of results) {
      expect(r.rows[0].one).toBe(1);
    }
  });

  test("clearDatabase throws in production environment", async () => {
    const originalNodeEnv = Bun.env.NODE_ENV;
    Bun.env.NODE_ENV = "production";
    try {
      await expect(api.db.clearDatabase()).rejects.toThrow(TypedError);
      try {
        await api.db.clearDatabase();
      } catch (e) {
        expect(e).toBeInstanceOf(TypedError);
        expect((e as TypedError).type).toBe(ErrorType.SERVER_INITIALIZATION);
        expect((e as TypedError).message).toContain("production");
      }
    } finally {
      Bun.env.NODE_ENV = originalNodeEnv;
    }
  });

  test("stop() is a no-op when pool was never initialized", async () => {
    // Verifies the `if (api.db.db && api.db.pool)` guard in DB.stop().
    const standalone = new DB();
    const liveDb = api.db;
    (api as any).db = { db: undefined, pool: undefined };
    try {
      await expect(standalone.stop()).resolves.toBeUndefined();
    } finally {
      (api as any).db = liveDb;
    }
  });
});

describe("DB pool exhaustion", () => {
  const originalMax = config.database.pool.max;
  const originalConnectTimeout = config.database.pool.connectionTimeoutMillis;

  beforeAll(async () => {
    await api.stop();
    config.database.pool.max = 2;
    config.database.pool.connectionTimeoutMillis = 500;
    await api.start();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await api.stop();
    config.database.pool.max = originalMax;
    config.database.pool.connectionTimeoutMillis = originalConnectTimeout;
    await api.start();
  }, HOOK_TIMEOUT);

  test("queues requests beyond pool.max instead of erroring", async () => {
    const start = Date.now();
    const queries = Array.from({ length: 4 }, () =>
      api.db.pool.query("SELECT pg_sleep(0.2), 1 as one"),
    );
    // Yield so the pool dispatches 2 and queues the rest.
    await new Promise((r) => setTimeout(r, 20));
    expect(api.db.pool.waitingCount).toBeGreaterThanOrEqual(1);
    expect(api.db.pool.totalCount).toBeLessThanOrEqual(2);

    const results = await Promise.all(queries);
    expect(results).toHaveLength(4);
    for (const r of results) expect(r.rows[0].one).toBe(1);
    // 4 queries × 0.2s serialized 2-at-a-time should take ~0.4s.
    expect(Date.now() - start).toBeGreaterThanOrEqual(350);
  });

  test("rejects with a timeout error when queue wait exceeds connectionTimeoutMillis", async () => {
    const held = Array.from({ length: 2 }, () =>
      api.db.pool.query("SELECT pg_sleep(2)").catch(() => undefined),
    );
    // Yield so held queries claim both connections.
    await new Promise((r) => setTimeout(r, 20));

    await expect(api.db.pool.query("SELECT 1")).rejects.toThrow(
      /timeout|timed out/i,
    );

    // Let the held queries finish (or fail on shutdown) before moving on.
    await Promise.all(held);
  });

  test("pool recovers after the queue drains", async () => {
    const result = await api.db.pool.query("SELECT 1::int as one");
    expect(result.rows[0].one).toBe(1);
    expect(api.db.pool.waitingCount).toBe(0);

    const burst = await Promise.all(
      Array.from({ length: 4 }, () =>
        api.db.pool.query("SELECT 1::int as one"),
      ),
    );
    expect(burst).toHaveLength(4);
    for (const r of burst) expect(r.rows[0].one).toBe(1);
  });

  test("pool.end() drains in-flight queries on graceful shutdown", async () => {
    // Standalone pool so we don't tear down api.db mid-suite.
    const pool = new Pool({
      connectionString: config.database.connectionString,
      max: 2,
    });
    const inflight = Promise.all([
      pool.query("SELECT pg_sleep(0.2), 1 as one"),
      pool.query("SELECT pg_sleep(0.2), 2 as two"),
    ]);
    // Yield so queries claim connections before we request shutdown.
    await new Promise((r) => setTimeout(r, 20));

    const ended = pool.end();
    const [results] = await Promise.all([inflight, ended]);
    const [q1, q2] = results;
    expect(q1.rows[0].one).toBe(1);
    expect(q2.rows[0].two).toBe(2);

    await expect(pool.query("SELECT 1")).rejects.toThrow();
  });
});
