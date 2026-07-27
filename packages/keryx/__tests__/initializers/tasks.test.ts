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
import { Action, api, Connection, config, RUN_MODE } from "../../api";
import { DEFAULT_QUEUE } from "../../classes/Action";
import { HOOK_TIMEOUT, waitFor } from "./../setup";

// Backend-agnostic contract tests. The active backend + fan-out store are chosen from
// `config.tasks` at boot (TASKS_BACKEND / TASKS_FANOUT_STORE), so this same suite runs against
// node-resque+redis (default) and pg-boss+postgres (CI matrix). Only the between-test cleanup
// is backend-aware.
const BACKEND = config.tasks.backend;

async function startInitializer(name: string) {
  const initializer = api.initializers.find((i) => i.name === name);
  // @ts-ignore — start() exists on the concrete initializer
  await initializer.start();
}

/** Wipe all pending/queued task + fan-out state between tests, regardless of backend. */
async function resetTaskState() {
  try {
    await api.redis.redis.flushdb();
  } catch {
    // redis may be unused under pg-boss + postgres
  }
  if (BACKEND === "pg-boss") {
    try {
      await api.db.pool.query(
        `DELETE FROM "${config.tasks.pgBoss.schema}".job`,
      );
    } catch {
      // schema not created yet
    }
  }
  if (config.tasks.fanOutStore === "postgres") {
    try {
      await api.db.pool.query("DELETE FROM keryx_fanout");
    } catch {
      // tables not created yet
    }
  }
}

beforeAll(async () => {
  await api.initialize();
  await startInitializer("redis");
  await startInitializer("db");
  await api.tasks.fanOutStore.start();
  // CLI mode: connect the backend for enqueuing without spinning up workers/scheduler.
  await api.tasks.backend.start(RUN_MODE.CLI);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

let ran: string | null = null;

const testActionInputs = z.object({
  val: z.string().default("I ran"),
});

class TestAction implements Action {
  name = "test_action";
  inputs = testActionInputs;
  run = async (params: z.infer<typeof testActionInputs>): Promise<void> => {
    ran = params.val;
  };
}

beforeEach(async () => {
  await resetTaskState();
  ran = null;
  api.actions.actions = api.actions.actions.filter(
    (a) => a.name !== "test_action",
  );
  const instance = new TestAction();
  api.actions.actions.push(instance);
  api.tasks.registerAction(instance);
});

afterEach(() => {
  api.actions.actions = api.actions.actions.filter(
    (a) => a.name !== "test_action" && a.name !== "recurring_test_action",
  );
  api.tasks.unregisterAction("test_action");
  api.tasks.unregisterAction("recurring_test_action");
});

test("actions can be enqueued", async () => {
  const enqueued = await api.actions.enqueue("test_action");
  expect(enqueued).toBe(true);
  const jobs = await api.actions.queued();
  expect(jobs.length).toBe(1);
  expect(jobs[0].class).toBe("test_action");
});

test("actions with different args are both enqueued", async () => {
  const enqueued_A = await api.actions.enqueue("test_action", { val: "I ran" });
  const enqueued_B = await api.actions.enqueue("test_action", {
    val: "other args",
  });
  const jobs = await api.actions.queued();
  expect(enqueued_A).toBe(true);
  expect(enqueued_B).toBe(true);
  expect(jobs.length).toBe(2);
  expect(jobs.map((j) => j.args[0].val).sort()).toEqual([
    "I ran",
    "other args",
  ]);
});

test("actions can be enqueued later", async () => {
  const enqueued = await api.actions.enqueueIn(5000, "test_action", {
    val: "test",
  });
  expect(enqueued).toBe(true);
  const jobs = await api.actions.queued();
  expect(jobs.length).toBe(0);
  const delayed = await api.actions.scheduledAt(DEFAULT_QUEUE, "test_action", {
    val: "test",
  });
  expect(delayed.length).toBe(1);
  expect(delayed[0]).toBeGreaterThan(Date.now() / 1000);
});

describe("with workers and scheduler", () => {
  afterEach(async () => {
    await api.tasks.stopWorkers();
    await api.tasks.stopScheduler();
  }, HOOK_TIMEOUT);

  test(
    "actions will be worked by workers",
    async () => {
      await api.actions.enqueue("test_action", { val: "I ran" });
      await api.tasks.startWorkers();
      await waitFor(() => ran !== null, { timeout: 20_000 });
      expect(ran).toBe("I ran");
    },
    HOOK_TIMEOUT,
  );

  test(
    "delayed actions will be worked by workers",
    async () => {
      await api.actions.enqueueIn(1, "test_action", { val: "I ran" });
      await api.tasks.startWorkers();
      await api.tasks.startScheduler();
      await waitFor(() => ran !== null, { timeout: 20_000 });
      expect(ran).toBe("I ran");
    },
    HOOK_TIMEOUT,
  );

  test(
    "recurring actions will be enqueued and worked",
    async () => {
      const runs: number[] = [];

      class RecurringTestAction implements Action {
        name = "recurring_test_action";
        task = { frequency: 100, queue: DEFAULT_QUEUE };
        run = async () => {
          runs.push(Date.now());
        };
      }
      const instance = new RecurringTestAction();
      api.actions.actions.push(instance);
      api.tasks.registerAction(instance);

      await api.tasks.startWorkers();
      await api.tasks.startScheduler();
      await waitFor(() => runs.length > 1, { timeout: 30_000 });
      expect(runs.length).toBeGreaterThan(1);
    },
    HOOK_TIMEOUT,
  );

  test(
    "task actions receive a task-typed connection with an empty session (fresh start)",
    async () => {
      let sessionData: Record<string, any> | undefined;
      let connectionType: string | undefined;

      class BareAction implements Action {
        name = "bare_action";
        inputs = z.object({});
        run = async (
          _params: Record<string, unknown>,
          connection: Connection,
        ): Promise<void> => {
          sessionData = connection.session?.data;
          connectionType = connection.type;
        };
      }
      const instance = new BareAction();
      api.actions.actions.push(instance);
      api.tasks.registerAction(instance);

      await api.actions.enqueue("bare_action");
      await api.tasks.startWorkers();
      await waitFor(() => sessionData !== undefined, { timeout: 20_000 });

      expect(sessionData).toEqual({});
      expect(connectionType).toBe("task");

      api.actions.actions = api.actions.actions.filter(
        (a) => a.name !== "bare_action",
      );
      api.tasks.unregisterAction("bare_action");
    },
    HOOK_TIMEOUT,
  );

  test(
    "beforeJob and afterJob hooks fire on success with shared ctx",
    async () => {
      const before: string[] = [];
      const after: Array<{ outcome: string; marker: unknown }> = [];
      const before_ = (name: string, _p: any, ctx: any) => {
        before.push(name);
        ctx.metadata.marker = "from-before";
      };
      const after_ = (_n: string, _p: any, ctx: any, outcome: any) => {
        after.push({
          outcome: outcome.success ? "success" : "failure",
          marker: ctx.metadata.marker,
        });
      };
      api.hooks.resque.beforeJob(before_);
      api.hooks.resque.afterJob(after_);

      try {
        await api.actions.enqueue("test_action", { val: "hooked" });
        await api.tasks.startWorkers();
        await waitFor(() => after.length > 0, { timeout: 20_000 });
        expect(before).toEqual(["test_action"]);
        expect(after).toEqual([{ outcome: "success", marker: "from-before" }]);
      } finally {
        const hooksInitializer = api.initializers.find(
          (i) => i.name === "hooks",
        );
        (hooksInitializer as any).resqueBeforeJob.length = 0;
        (hooksInitializer as any).resqueAfterJob.length = 0;
      }
    },
    HOOK_TIMEOUT,
  );

  test(
    "afterJob receives failure outcome when action throws",
    async () => {
      const outcomes: Array<{ success: boolean; errorMessage?: string }> = [];
      api.hooks.resque.afterJob((_n, _p, _ctx, outcome) => {
        outcomes.push({
          success: outcome.success,
          errorMessage: outcome.success
            ? undefined
            : (outcome.error as Error)?.message,
        });
      });

      class ExplodingAction implements Action {
        name = "exploding_action";
        inputs = z.object({});
        run = async (): Promise<void> => {
          throw new Error("kaboom");
        };
      }
      const instance = new ExplodingAction();
      api.actions.actions.push(instance);
      api.tasks.registerAction(instance);

      try {
        await api.actions.enqueue("exploding_action");
        await api.tasks.startWorkers();
        await waitFor(() => outcomes.length > 0, { timeout: 20_000 });
        expect(outcomes[0].success).toBe(false);
        expect(outcomes[0].errorMessage).toContain("kaboom");
      } finally {
        const hooksInitializer2 = api.initializers.find(
          (i) => i.name === "hooks",
        );
        (hooksInitializer2 as any).resqueAfterJob.length = 0;
        api.actions.actions = api.actions.actions.filter(
          (a) => a.name !== "exploding_action",
        );
        api.tasks.unregisterAction("exploding_action");
      }
    },
    HOOK_TIMEOUT,
  );
});

describe("onEnqueue hook", () => {
  afterEach(() => {
    const hooksInitializer = api.initializers.find((i) => i.name === "hooks");
    (hooksInitializer as any).actionsOnEnqueue.length = 0;
  });

  test("fires for enqueue with actionName, inputs, and queue", async () => {
    const calls: Array<{
      actionName: string;
      inputs: any;
      queue: string;
    }> = [];
    api.hooks.actions.onEnqueue((actionName, inputs, queue) => {
      calls.push({ actionName, inputs, queue });
    });

    await api.actions.enqueue("test_action", { val: "payload" });
    expect(calls).toEqual([
      {
        actionName: "test_action",
        inputs: { val: "payload" },
        queue: DEFAULT_QUEUE,
      },
    ]);
  });

  test("returning new inputs replaces the enqueued payload", async () => {
    api.hooks.actions.onEnqueue((_name, inputs) => ({
      ...inputs,
      injected: "yes",
    }));

    await api.actions.enqueue("test_action", { val: "orig" });
    const jobs = await api.actions.queued();
    expect(jobs[0].args[0]).toEqual({ val: "orig", injected: "yes" });
  });

  test("fires for enqueueIn", async () => {
    let fired = false;
    api.hooks.actions.onEnqueue(() => {
      fired = true;
    });
    await api.actions.enqueueIn(5000, "test_action", { val: "delayed" });
    expect(fired).toBe(true);
  });

  test("fires for enqueueAt", async () => {
    let fired = false;
    api.hooks.actions.onEnqueue(() => {
      fired = true;
    });
    await api.actions.enqueueAt(
      Date.now() + 5000,
      "test_action",
      { val: "at" },
      DEFAULT_QUEUE,
      true,
    );
    expect(fired).toBe(true);
  });

  test("multiple hooks run in order and thread inputs through", async () => {
    api.hooks.actions.onEnqueue((_n, inputs) => ({ ...inputs, a: 1 }));
    api.hooks.actions.onEnqueue((_n, inputs) => ({ ...inputs, b: 2 }));
    await api.actions.enqueue("test_action", { val: "chain" });
    const jobs = await api.actions.queued();
    expect(jobs[0].args[0]).toEqual({ val: "chain", a: 1, b: 2 });
  });
});

describe("taskDetails", () => {
  test("returns queues, workers, stats, and leader", async () => {
    await api.actions.enqueue("test_action", { val: "x" });
    const details = await api.actions.taskDetails();
    expect(typeof details.leader).toBe("string");
    expect(details.queues).toBeDefined();
    expect(details.stats).toBeDefined();
    expect(details.workers).toBeDefined();
  });
});
