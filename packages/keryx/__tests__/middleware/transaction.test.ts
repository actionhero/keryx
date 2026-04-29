import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { api, CONNECTION_TYPE, Connection } from "../../api";
import { Action, type ActionMiddleware } from "../../classes/Action";
import { ErrorType, TypedError } from "../../classes/TypedError";
import { TransactionMiddleware } from "../../middleware/transaction";
import { HOOK_TIMEOUT } from "../setup";

const TABLE = "_keryx_tx_test";

beforeAll(async () => {
  await api.start();
  await api.db.db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (id serial primary key, val text not null)`,
    ),
  );
  await api.db.db.execute(sql.raw(`TRUNCATE TABLE ${TABLE} RESTART IDENTITY`));
}, HOOK_TIMEOUT);

afterAll(async () => {
  // Remove any test actions we registered so later tests don't see them
  api.actions.actions = api.actions.actions.filter(
    (a: Action) => !a.name.startsWith("test:tx:"),
  );
  await api.db.db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE}`));
  await api.stop();
}, HOOK_TIMEOUT);

async function countRows(): Promise<number> {
  const result = await api.db.db.execute(
    sql.raw(`SELECT COUNT(*)::int AS c FROM ${TABLE}`),
  );
  const rows = result.rows as unknown as Array<{ c: number }>;
  return rows[0].c;
}

async function truncate(): Promise<void> {
  await api.db.db.execute(sql.raw(`TRUNCATE TABLE ${TABLE} RESTART IDENTITY`));
}

class InsertAction extends Action {
  constructor(name: string, opts: { throwAfter?: boolean } = {}) {
    super({
      name,
      middleware: [TransactionMiddleware],
      inputs: z.object({ val: z.string() }),
    });
    this.throwAfter = opts.throwAfter ?? false;
  }
  throwAfter: boolean;

  async run(
    params: { val: string },
    connection: Connection,
  ): Promise<{ ok: boolean }> {
    const tx = connection.metadata.transaction as any;
    await tx.execute(
      sql`INSERT INTO ${sql.raw(TABLE)} (val) VALUES (${params.val})`,
    );
    if (this.throwAfter) {
      throw new TypedError({
        message: "intentional rollback",
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
    return { ok: true };
  }
}

class NestedAction extends Action {
  constructor(name: string, innerName: string) {
    super({
      name,
      middleware: [TransactionMiddleware],
      inputs: z.object({}).passthrough(),
    });
    this.innerName = innerName;
  }
  innerName: string;

  async run(
    _params: Record<string, unknown>,
    connection: Connection,
  ): Promise<{
    innerDepthSeen: number;
    innerError?: TypedError;
  }> {
    const outerTx = connection.metadata.transaction as any;
    // Insert a row from the OUTER action so we can verify it shares the TX
    await outerTx.execute(
      sql`INSERT INTO ${sql.raw(TABLE)} (val) VALUES ('outer')`,
    );

    const innerResult = await connection.act(this.innerName, { val: "inner" });
    const innerDepthSeen = (connection.metadata as any)._txDepth as number;
    return { innerDepthSeen, innerError: innerResult.error };
  }
}

function register(action: Action): void {
  api.actions.actions.push(action);
}

describe("TransactionMiddleware", () => {
  test("commits when the action succeeds", async () => {
    await truncate();
    register(new InsertAction("test:tx:commit"));

    const conn = new Connection(CONNECTION_TYPE.WEB, "tx-1");
    try {
      const { error } = await conn.act("test:tx:commit", { val: "committed" });
      expect(error).toBeUndefined();
      expect(await countRows()).toBe(1);

      const rows = (
        await api.db.db.execute(sql.raw(`SELECT val FROM ${TABLE}`))
      ).rows as unknown as Array<{ val: string }>;
      expect(rows[0].val).toBe("committed");

      // Transaction metadata cleared after commit
      expect(conn.metadata.transaction).toBeUndefined();
      expect((conn.metadata as any)._txClient).toBeUndefined();
      expect((conn.metadata as any)._txDepth).toBe(0);
    } finally {
      conn.destroy();
    }
  });

  test("rolls back when the action throws", async () => {
    await truncate();
    register(new InsertAction("test:tx:rollback", { throwAfter: true }));

    const conn = new Connection(CONNECTION_TYPE.WEB, "tx-2");
    try {
      const { error } = await conn.act("test:tx:rollback", {
        val: "should-not-persist",
      });
      expect(error).toBeDefined();
      expect((error as TypedError).message).toContain("intentional rollback");
      expect(await countRows()).toBe(0);
      expect(conn.metadata.transaction).toBeUndefined();
      expect((conn.metadata as any)._txClient).toBeUndefined();
    } finally {
      conn.destroy();
    }
  });

  test("nested actions share the outer transaction (commit path)", async () => {
    await truncate();
    register(new InsertAction("test:tx:inner-ok"));
    register(new NestedAction("test:tx:nested-ok", "test:tx:inner-ok"));

    const conn = new Connection(CONNECTION_TYPE.WEB, "tx-3");
    try {
      const { response, error } = (await conn.act("test:tx:nested-ok", {})) as {
        response: { innerDepthSeen: number; innerError?: TypedError };
        error?: TypedError;
      };
      expect(error).toBeUndefined();

      // Depth sampled AFTER inner runAfter: outer still owns the tx => 1
      expect(response.innerDepthSeen).toBe(1);
      expect(response.innerError).toBeUndefined();

      // Both rows land in the committed transaction
      const rows = (
        await api.db.db.execute(sql.raw(`SELECT val FROM ${TABLE} ORDER BY id`))
      ).rows as unknown as Array<{ val: string }>;
      expect(rows.map((r) => r.val)).toEqual(["outer", "inner"]);
    } finally {
      conn.destroy();
    }
  });

  test("inner action failure propagates and rolls back the outer transaction", async () => {
    await truncate();
    register(new InsertAction("test:tx:inner-fail", { throwAfter: true }));

    // Outer action: inserts a row, then invokes a failing inner action, and
    // re-throws so the outer middleware rolls back.
    class OuterFailingAction extends Action {
      constructor() {
        super({
          name: "test:tx:outer-fail",
          middleware: [TransactionMiddleware],
          inputs: z.object({}).passthrough(),
        });
      }
      async run(
        _params: Record<string, unknown>,
        connection: Connection,
      ): Promise<{ ok: boolean }> {
        const tx = connection.metadata.transaction as any;
        await tx.execute(
          sql`INSERT INTO ${sql.raw(TABLE)} (val) VALUES ('outer')`,
        );
        const inner = await connection.act("test:tx:inner-fail", {
          val: "inner",
        });
        if (inner.error) throw inner.error;
        return { ok: true };
      }
    }
    register(new OuterFailingAction());

    const conn = new Connection(CONNECTION_TYPE.WEB, "tx-4");
    try {
      const { error } = await conn.act("test:tx:outer-fail", {});
      expect(error).toBeDefined();
      // Outer row must NOT persist — the outer middleware owns the ROLLBACK
      expect(await countRows()).toBe(0);
    } finally {
      conn.destroy();
    }
  });

  test("runAfter with depth 0 and no stored client is a no-op", async () => {
    // Exercises the `if (!client) return` guard without going through an action.
    const conn = new Connection(CONNECTION_TYPE.WEB, "tx-5");
    try {
      await expect(
        TransactionMiddleware.runAfter!({}, conn, undefined),
      ).resolves.toBeUndefined();
    } finally {
      conn.destroy();
    }
  });

  test("does not leak pool clients across many sequential transactions", async () => {
    await truncate();
    register(new InsertAction("test:tx:leak-check"));

    const before = api.db.pool.totalCount;
    for (let i = 0; i < 8; i++) {
      const conn = new Connection(CONNECTION_TYPE.WEB, `tx-leak-${i}`);
      try {
        const { error } = await conn.act("test:tx:leak-check", {
          val: `row-${i}`,
        });
        expect(error).toBeUndefined();
      } finally {
        conn.destroy();
      }
    }
    // Pool size shouldn't balloon — all clients released back to the pool.
    // Allow a little slack for internal drizzle/pg bookkeeping.
    expect(api.db.pool.totalCount - before).toBeLessThanOrEqual(2);
    expect(api.db.pool.waitingCount).toBe(0);
  });

  test("middleware is callable via the exported ActionMiddleware shape", () => {
    const mw: ActionMiddleware = TransactionMiddleware;
    expect(typeof mw.runBefore).toBe("function");
    expect(typeof mw.runAfter).toBe("function");
  });
});
