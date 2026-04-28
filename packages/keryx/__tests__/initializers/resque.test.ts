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
import { Action, api, Connection } from "../../api";
import { DEFAULT_QUEUE } from "../../classes/Action";
import { HOOK_TIMEOUT, waitFor } from "./../setup";

beforeAll(async () => {
  await api.initialize();
  const redisInitializer = api.initializers.find((i) => i.name === "redis");
  // @ts-ignore
  await redisInitializer.start();

  const dbInitializer = api.initializers.find((i) => i.name === "db");
  // @ts-ignore
  await dbInitializer.start();

  await api.resque.startQueue();
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

afterEach(() => {
  // Remove any test_action instances to avoid polluting other test suites
  api.actions.actions = api.actions.actions.filter(
    (a) => a.name !== "test_action",
  );
  delete api.resque.jobs["test_action"];
});

beforeEach(async () => {
  await api.redis.redis.flushdb();
  ran = null;
  // Remove any previous test_action before adding a fresh one
  api.actions.actions = api.actions.actions.filter(
    (a) => a.name !== "test_action",
  );
  const instance = new TestAction();
  api.actions.actions.push(instance);
  api.resque.jobs[instance.name] = api.resque.wrapActionAsJob(instance);
});

afterEach(() => {
  // Remove test actions so they don't leak into subsequent test files
  api.actions.actions = api.actions.actions.filter(
    (a) => a.name !== "test_action" && a.name !== "recurring_test_action",
  );
  delete api.resque.jobs.test_action;
  delete api.resque.jobs.recurring_test_action;
});

test("actions can be enqueued", async () => {
  const enqueued = await api.actions.enqueue("test_action");
  expect(enqueued).toBe(true);
  const jobs = await api.actions.queued();
  expect(jobs.length).toBe(1);
  expect(jobs[0].class).toBe("test_action");
});

test("actions with the different args will only be enqueued", async () => {
  const enqueued_A = await api.actions.enqueue("test_action", { val: "I ran" });
  const enqueued_B = await api.actions.enqueue("test_action", {
    val: "other args",
  });
  const jobs = await api.actions.queued();
  expect(enqueued_A).toBe(true);
  expect(enqueued_B).toBe(true);
  expect(jobs.length).toBe(2);
  expect(jobs.map((j) => j.args[0].val)).toEqual(["I ran", "other args"]);
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
    await api.resque.stopWorkers();
    await api.resque.stopScheduler();
  });

  test("actions will be worked by workers", async () => {
    await api.actions.enqueue("test_action", { val: "I ran" });
    await api.resque.startWorkers();
    expect(ran).toBeNull();
    await waitFor(() => ran !== null);
    expect(ran).toBe("I ran");
  });

  test("delayed actions will be worked by workers", async () => {
    await api.actions.enqueueIn(1, "test_action", { val: "I ran" });
    await api.resque.startWorkers();
    await api.resque.startScheduler();
    expect(ran).toBeNull();
    await waitFor(() => ran !== null);
    expect(ran).toBe("I ran");
  });

  test("recurring actions will be enqueued and worked", async () => {
    const runs: number[] = [];

    class RecurringTestAction implements Action {
      name = "recurring_test_action";
      task = { frequency: 100, queue: DEFAULT_QUEUE };
      run = async () => {
        runs.push(Date.now());
      };
    }
    const instance = new RecurringTestAction();
    api.resque.jobs[instance.name] = api.resque.wrapActionAsJob(instance);
    api.actions.actions.push(instance);

    await api.resque.startWorkers();
    await api.resque.startScheduler();
    await waitFor(() => runs.length > 1);
    expect(runs.length).toBeGreaterThan(1);
  });

  test("task actions receive a task-typed connection with an empty session (fresh start)", async () => {
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
    api.resque.jobs[instance.name] = api.resque.wrapActionAsJob(instance);

    await api.actions.enqueue("bare_action");
    await api.resque.startWorkers();
    await waitFor(() => sessionData !== undefined);

    expect(sessionData).toEqual({});
    expect(connectionType).toBe("task");

    api.actions.actions = api.actions.actions.filter(
      (a) => a.name !== "bare_action",
    );
    delete api.resque.jobs.bare_action;
  });

  test("beforeJob and afterJob hooks fire on success with shared ctx", async () => {
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
      await api.resque.startWorkers();
      await waitFor(() => after.length > 0);
      expect(before).toEqual(["test_action"]);
      expect(after).toEqual([{ outcome: "success", marker: "from-before" }]);
    } finally {
      const hooksInitializer = api.initializers.find((i) => i.name === "hooks");
      (hooksInitializer as any).resqueBeforeJob.clear();
      (hooksInitializer as any).resqueAfterJob.clear();
    }
  });

  test("afterJob receives failure outcome when action throws", async () => {
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
    api.resque.jobs[instance.name] = api.resque.wrapActionAsJob(instance);

    try {
      await api.actions.enqueue("exploding_action");
      await api.resque.startWorkers();
      await waitFor(() => outcomes.length > 0);
      expect(outcomes[0].success).toBe(false);
      expect(outcomes[0].errorMessage).toContain("kaboom");
    } finally {
      const hooksInitializer2 = api.initializers.find(
        (i) => i.name === "hooks",
      );
      (hooksInitializer2 as any).resqueAfterJob.clear();
      api.actions.actions = api.actions.actions.filter(
        (a) => a.name !== "exploding_action",
      );
      delete api.resque.jobs.exploding_action;
    }
  });
});

describe("onEnqueue hook", () => {
  afterEach(() => {
    const hooksInitializer = api.initializers.find((i) => i.name === "hooks");
    (hooksInitializer as any).actionsOnEnqueue.clear();
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

describe("Redis disconnect during enqueue (issue #385)", () => {
  // Each test disconnects the primary client to simulate a Redis outage during
  // enqueue. We MUST reconnect before the test ends — the shared `beforeEach`
  // flushdb call on the primary client would otherwise fail for the next test.
  afterEach(async () => {
    if (api.redis.redis.status !== "ready") {
      try {
        await api.redis.redis.connect();
      } catch {
        // already connecting or connected — fall through to waitFor
      }
      await waitFor(() => api.redis.redis.status === "ready");
    }
  });

  test("rejects and leaves no phantom task when Redis is unreachable", async () => {
    api.redis.redis.disconnect(false);
    await waitFor(() => api.redis.redis.status === "end");

    await expect(
      api.actions.enqueue("test_action", { val: "x" }),
    ).rejects.toThrow(/Connection is closed/);

    // Reconnect so we can inspect queue state for a phantom task.
    await api.redis.redis.connect();
    await waitFor(() => api.redis.redis.status === "ready");

    const jobs = await api.actions.queued();
    expect(jobs.filter((j) => j.class === "test_action")).toHaveLength(0);

    const delayed = await api.actions.allDelayed();
    expect(delayed).toEqual({});
  });

  test("subsequent enqueue succeeds after the primary client reconnects", async () => {
    api.redis.redis.disconnect(false);
    await waitFor(() => api.redis.redis.status === "end");

    await api.redis.redis.connect();
    await waitFor(() => api.redis.redis.status === "ready");

    const ok = await api.actions.enqueue("test_action", {
      val: "after-reconnect",
    });
    expect(ok).toBe(true);

    const jobs = await api.actions.queued();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].class).toBe("test_action");
    expect(jobs[0].args[0].val).toBe("after-reconnect");
  });

  test("retry after a failed enqueue does not double-enqueue", async () => {
    api.redis.redis.disconnect(false);
    await waitFor(() => api.redis.redis.status === "end");

    await expect(
      api.actions.enqueue("test_action", { val: "retry" }),
    ).rejects.toThrow(/Connection is closed/);

    await api.redis.redis.connect();
    await waitFor(() => api.redis.redis.status === "ready");

    const ok = await api.actions.enqueue("test_action", { val: "retry" });
    expect(ok).toBe(true);

    const jobs = await api.actions.queued();
    expect(jobs.filter((j) => j.class === "test_action")).toHaveLength(1);
  });
});
