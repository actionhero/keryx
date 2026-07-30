import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { z } from "zod";
import { Action, api, config, RUN_MODE } from "../../api";
import { HOOK_TIMEOUT, waitFor } from "./../setup";

async function startInitializer(name: string) {
  const initializer = api.initializers.find((i) => i.name === name);
  // @ts-ignore — start() exists on the concrete initializer
  await initializer.start();
}

class BoomAction implements Action {
  name = "pgboss_boom";
  inputs = z.object({});
  run = async (): Promise<void> => {
    throw new Error("boom");
  };
}

class NoopAction implements Action {
  name = "pgboss_noop";
  inputs = z.object({ v: z.string().default("x") });
  run = async (): Promise<void> => {};
}

class RecurringNoopAction implements Action {
  name = "pgboss_recurring";
  task = { frequency: 60_000, queue: "default" };
  run = async (): Promise<void> => {};
}

// Must match PgBossBackend's internal RECURRING_QUEUE constant.
const RECURRING_QUEUE = "keryx__recurring";

describe("PgBossBackend", () => {
  beforeAll(async () => {
    await api.initialize();
    await startInitializer("redis");
    await startInitializer("db");
    await api.tasks.fanOutStore.start();
    await api.tasks.backend.start(RUN_MODE.CLI);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await api.stop();
  }, HOOK_TIMEOUT);

  beforeEach(async () => {
    await api.db.pool.query(`DELETE FROM "${config.tasks.pgBoss.schema}".job`);
    for (const ActionClass of [BoomAction, NoopAction]) {
      const instance = new ActionClass();
      api.actions.actions = api.actions.actions.filter(
        (a) => a.name !== instance.name,
      );
      api.actions.actions.push(instance);
      api.tasks.registerAction(instance);
    }
  });

  afterEach(async () => {
    await api.tasks.stopWorkers();
    api.actions.actions = api.actions.actions.filter(
      (a) => a.name !== "pgboss_boom" && a.name !== "pgboss_noop",
    );
    api.tasks.unregisterAction("pgboss_boom");
    api.tasks.unregisterAction("pgboss_noop");
  });

  test("creates and owns its own schema + job table on start", async () => {
    const { rows } = await api.db.pool.query(`SELECT to_regclass($1) AS tbl`, [
      `"${config.tasks.pgBoss.schema}".job`,
    ]);
    expect(rows[0].tbl).not.toBeNull();
  });

  test(
    "failed jobs are recorded and can be removed",
    async () => {
      await api.actions.enqueue("pgboss_boom", {});
      await api.tasks.startWorkers();

      await waitFor(async () => (await api.actions.failedCount()) >= 1, {
        timeout: 20_000,
      });

      const failedList = await api.actions.failed(0, 10);
      const ours = failedList.find((f) => f.payload.class === "pgboss_boom");
      expect(ours).toBeDefined();
      expect(ours!.error).toContain("boom");

      await api.actions.removeFailed(ours!);
      await waitFor(async () => (await api.actions.failedCount()) === 0, {
        timeout: 10_000,
      });
      expect(await api.actions.failedCount()).toBe(0);
    },
    HOOK_TIMEOUT,
  );

  test("del removes queued jobs before they run", async () => {
    await api.actions.enqueue("pgboss_noop", { v: "a" });
    await api.actions.enqueue("pgboss_noop", { v: "b" });
    expect((await api.actions.queued("default")).length).toBe(2);

    const removed = await api.actions.del("default", "pgboss_noop");
    expect(removed).toBe(2);
    expect((await api.actions.queued("default")).length).toBe(0);
  });

  test("recurring jobs stay single-instance across repeated enqueues (no leader needed)", async () => {
    const instance = new RecurringNoopAction();
    api.actions.actions = api.actions.actions.filter(
      (a) => a.name !== instance.name,
    );
    api.actions.actions.push(instance);
    api.tasks.registerAction(instance);

    try {
      // Simulate several processes all enqueuing the same recurring action at boot.
      const results = await Promise.all([
        api.actions.enqueue("pgboss_recurring", {}),
        api.actions.enqueue("pgboss_recurring", {}),
        api.actions.enqueue("pgboss_recurring", {}),
        api.actions.enqueue("pgboss_recurring", {}),
        api.actions.enqueue("pgboss_recurring", {}),
      ]);

      // Exactly one enqueue "wins"; the rest are deduped by the short-policy unique index.
      expect(results.filter((r) => r === true).length).toBe(1);

      const { rows } = await api.db.pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM "${config.tasks.pgBoss.schema}".job
         WHERE name = $1 AND data->>'_actionName' = $2 AND state = 'created'`,
        [RECURRING_QUEUE, "pgboss_recurring"],
      );
      expect(rows[0].c).toBe(1);
    } finally {
      await api.db.pool.query(
        `DELETE FROM "${config.tasks.pgBoss.schema}".job WHERE name = $1`,
        [RECURRING_QUEUE],
      );
      api.actions.actions = api.actions.actions.filter(
        (a) => a.name !== "pgboss_recurring",
      );
      api.tasks.unregisterAction("pgboss_recurring");
    }
  });

  test("delayed jobs are excluded from queued() and cleared by delDelayed", async () => {
    await api.actions.enqueueIn(60_000, "pgboss_noop", { v: "later" });
    expect((await api.actions.queued("default")).length).toBe(0);

    const scheduled = await api.actions.scheduledAt("default", "pgboss_noop", {
      v: "later",
    });
    expect(scheduled.length).toBe(1);

    const cleared = await api.actions.delDelayed("default", "pgboss_noop");
    expect(cleared.length).toBe(1);
    expect(
      (await api.actions.scheduledAt("default", "pgboss_noop", { v: "later" }))
        .length,
    ).toBe(0);
  });
});
