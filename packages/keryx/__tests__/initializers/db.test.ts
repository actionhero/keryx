import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { api } from "../../api";
import { ErrorType, TypedError } from "../../classes/TypedError";
import { DB } from "../../initializers/db";
import { HOOK_TIMEOUT } from "../setup";

beforeAll(async () => {
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("DB initializer", () => {
  test("declares documented load/start/stop priorities", () => {
    const d = new DB();
    expect(d.loadPriority).toBe(100);
    expect(d.startPriority).toBe(100);
    expect(d.stopPriority).toBe(910);
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
