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
import { Action, api } from "../../api";
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

// --- Test actions ---

const processedItems: Array<{ id: string }> = [];

const childInputs = z.object({
  itemId: z.string(),
  _fanOutId: z.string().optional(),
});

class FanOutChildAction implements Action {
  name = "fanout:child";
  inputs = childInputs;
  task = { queue: "worker" };
  run = async (params: z.infer<typeof childInputs>) => {
    processedItems.push({ id: params.itemId });
    return { processed: params.itemId };
  };
}

const failingChildInputs = z.object({
  itemId: z.string(),
  _fanOutId: z.string().optional(),
});

class FailingFanOutChildAction implements Action {
  name = "fanout:failing-child";
  inputs = failingChildInputs;
  task = { queue: "worker" };
  run = async (params: z.infer<typeof failingChildInputs>) => {
    throw new Error(`failed processing ${params.itemId}`);
  };
}

const secondChildInputs = z.object({
  name: z.string(),
  _fanOutId: z.string().optional(),
});

class SecondChildAction implements Action {
  name = "fanout:second-child";
  inputs = secondChildInputs;
  task = { queue: "notifications" };
  run = async (params: z.infer<typeof secondChildInputs>) => {
    return { greeted: params.name };
  };
}

beforeEach(async () => {
  await api.redis.redis.flushdb();
  processedItems.length = 0;

  // Register test actions
  const child = new FanOutChildAction();
  api.actions.actions.push(child);
  api.resque.jobs[child.name] = api.resque.wrapActionAsJob(child);

  const failingChild = new FailingFanOutChildAction();
  api.actions.actions.push(failingChild);
  api.resque.jobs[failingChild.name] = api.resque.wrapActionAsJob(failingChild);

  const secondChild = new SecondChildAction();
  api.actions.actions.push(secondChild);
  api.resque.jobs[secondChild.name] = api.resque.wrapActionAsJob(secondChild);
});

afterEach(async () => {
  // Clean up test actions
  api.actions.actions = api.actions.actions.filter(
    (a) =>
      a.name !== "fanout:child" &&
      a.name !== "fanout:failing-child" &&
      a.name !== "fanout:second-child",
  );
  delete api.resque.jobs["fanout:child"];
  delete api.resque.jobs["fanout:failing-child"];
  delete api.resque.jobs["fanout:second-child"];
});

describe("fanOut", () => {
  test("enqueues all items and returns correct counts", async () => {
    const inputs = [{ itemId: "1" }, { itemId: "2" }, { itemId: "3" }];
    const result = await api.actions.fanOut("fanout:child", inputs);

    expect(result.enqueued).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(result.actionName).toBe("fanout:child");
    expect(result.fanOutId).toBeTruthy();
  });

  test("injects _fanOutId into each child job's inputs", async () => {
    const inputs = [{ itemId: "a" }, { itemId: "b" }];
    const result = await api.actions.fanOut("fanout:child", inputs);

    // Check the queued jobs have _fanOutId
    const jobs = await api.actions.queued("worker");
    expect(jobs.length).toBe(2);
    for (const job of jobs) {
      expect(job.args[0]._fanOutId).toBe(result.fanOutId);
    }
  });

  test("stores fan-out metadata in Redis with TTL", async () => {
    const inputs = [{ itemId: "1" }];
    const result = await api.actions.fanOut("fanout:child", inputs);

    const metaKey = `fanout:${result.fanOutId}`;
    const meta = await api.redis.redis.hgetall(metaKey);
    expect(meta.total).toBe("1");
    expect(meta.completed).toBe("0");
    expect(meta.failed).toBe("0");
    expect(meta.actionName).toBe("fanout:child");
    expect(meta.queue).toBe("worker");

    const ttl = await api.redis.redis.ttl(metaKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  test("falls back to action's task.queue when no queue specified", async () => {
    const inputs = [{ itemId: "1" }];
    const result = await api.actions.fanOut("fanout:child", inputs);

    expect(result.queue).toBe("worker"); // from FanOutChildAction.task.queue
    const jobs = await api.actions.queued("worker");
    expect(jobs.length).toBe(1);
  });

  test("explicit queue override works", async () => {
    const inputs = [{ itemId: "1" }];
    const result = await api.actions.fanOut(
      "fanout:child",
      inputs,
      "custom-queue",
    );

    expect(result.queue).toBe("custom-queue");
    const jobs = await api.actions.queued("custom-queue");
    expect(jobs.length).toBe(1);
  });

  test("throws on nonexistent action", async () => {
    expect(
      api.actions.fanOut("nonexistent:action", [{ itemId: "1" }]),
    ).rejects.toThrow("action nonexistent:action not found");
  });

  test("handles empty inputsArray", async () => {
    const result = await api.actions.fanOut("fanout:child", []);

    expect(result.enqueued).toBe(0);
    expect(result.errors).toHaveLength(0);

    const meta = await api.redis.redis.hgetall(`fanout:${result.fanOutId}`);
    expect(meta.total).toBe("0");
  });

  test("large fan-outs with custom batchSize", async () => {
    const inputs = Array.from({ length: 25 }, (_, i) => ({
      itemId: String(i),
    }));
    const result = await api.actions.fanOut("fanout:child", inputs, undefined, {
      batchSize: 10,
    });

    expect(result.enqueued).toBe(25);
    expect(result.errors).toHaveLength(0);

    const jobs = await api.actions.queued("worker", 0, 100);
    expect(jobs.length).toBe(25);
  });

  test("custom resultTtl is applied to Redis keys", async () => {
    const inputs = [{ itemId: "1" }];
    const result = await api.actions.fanOut("fanout:child", inputs, undefined, {
      resultTtl: 30,
    });

    const ttl = await api.redis.redis.ttl(`fanout:${result.fanOutId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });
});

describe("fanOutStatus", () => {
  test("returns zeros for unknown fanOutId", async () => {
    const status = await api.actions.fanOutStatus("nonexistent-id");
    expect(status.total).toBe(0);
    expect(status.completed).toBe(0);
    expect(status.failed).toBe(0);
    expect(status.results).toHaveLength(0);
    expect(status.errors).toHaveLength(0);
  });

  test("returns correct totals after fan-out creation", async () => {
    const inputs = [{ itemId: "1" }, { itemId: "2" }];
    const result = await api.actions.fanOut("fanout:child", inputs);

    const status = await api.actions.fanOutStatus(result.fanOutId);
    expect(status.total).toBe(2);
    expect(status.completed).toBe(0);
    expect(status.failed).toBe(0);
  });
});

describe("enqueue queue-parameter fix", () => {
  test("explicit queue is respected", async () => {
    await api.actions.enqueue("fanout:child", { itemId: "1" }, "my-queue");
    const jobs = await api.actions.queued("my-queue");
    expect(jobs.length).toBe(1);
  });

  test("falls back to action's queue when no queue specified", async () => {
    await api.actions.enqueue("fanout:child", { itemId: "1" });
    const jobs = await api.actions.queued("worker");
    expect(jobs.length).toBe(1);
  });
});

describe("fanOut multi-action", () => {
  test("enqueues jobs for multiple action types under one fanOutId", async () => {
    const result = await api.actions.fanOut([
      { action: "fanout:child", inputs: { itemId: "1" } },
      { action: "fanout:child", inputs: { itemId: "2" } },
      { action: "fanout:second-child", inputs: { name: "alice" } },
    ]);

    expect(result.enqueued).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(result.fanOutId).toBeTruthy();

    // actionName should be an array when multiple actions are used
    expect(result.actionName).toEqual(["fanout:child", "fanout:second-child"]);
  });

  test("each job resolves its own queue from its action", async () => {
    const result = await api.actions.fanOut([
      { action: "fanout:child", inputs: { itemId: "1" } }, // queue: "worker"
      { action: "fanout:second-child", inputs: { name: "bob" } }, // queue: "notifications"
    ]);

    expect(result.queue).toEqual(["worker", "notifications"]);

    const workerJobs = await api.actions.queued("worker");
    const notifJobs = await api.actions.queued("notifications");
    expect(workerJobs.length).toBe(1);
    expect(notifJobs.length).toBe(1);
  });

  test("per-job queue override works", async () => {
    await api.actions.fanOut([
      { action: "fanout:child", inputs: { itemId: "1" }, queue: "priority" },
      { action: "fanout:second-child", inputs: { name: "carol" } }, // falls back to "notifications"
    ]);

    const priorityJobs = await api.actions.queued("priority");
    const notifJobs = await api.actions.queued("notifications");
    expect(priorityJobs.length).toBe(1);
    expect(notifJobs.length).toBe(1);
  });

  test("throws if any action in the array does not exist", async () => {
    expect(
      api.actions.fanOut([
        { action: "fanout:child", inputs: { itemId: "1" } },
        { action: "nonexistent:action", inputs: {} },
      ]),
    ).rejects.toThrow("action nonexistent:action not found");
  });

  test("handles empty jobs array", async () => {
    const result = await api.actions.fanOut([]);
    expect(result.enqueued).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("options work with multi-action form", async () => {
    const result = await api.actions.fanOut(
      [
        { action: "fanout:child", inputs: { itemId: "1" } },
        { action: "fanout:second-child", inputs: { name: "dan" } },
      ],
      { resultTtl: 30 },
    );

    const ttl = await api.redis.redis.ttl(`fanout:${result.fanOutId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  test("single action in array returns string not array", async () => {
    const result = await api.actions.fanOut([
      { action: "fanout:child", inputs: { itemId: "1" } },
      { action: "fanout:child", inputs: { itemId: "2" } },
    ]);

    // Only one unique action name, so it should be a string
    expect(result.actionName).toBe("fanout:child");
    expect(result.queue).toBe("worker");
  });

  test("_fanOutId is injected into all jobs", async () => {
    const result = await api.actions.fanOut([
      { action: "fanout:child", inputs: { itemId: "1" } },
      { action: "fanout:second-child", inputs: { name: "eve" } },
    ]);

    const workerJobs = await api.actions.queued("worker");
    const notifJobs = await api.actions.queued("notifications");

    expect(workerJobs[0].args[0]._fanOutId).toBe(result.fanOutId);
    expect(notifJobs[0].args[0]._fanOutId).toBe(result.fanOutId);
  });

  test("metadata in Redis lists all action names and queues", async () => {
    const result = await api.actions.fanOut([
      { action: "fanout:child", inputs: { itemId: "1" } },
      { action: "fanout:second-child", inputs: { name: "frank" } },
    ]);

    const meta = await api.redis.redis.hgetall(`fanout:${result.fanOutId}`);
    expect(meta.total).toBe("2");
    expect(meta.actionName).toContain("fanout:child");
    expect(meta.actionName).toContain("fanout:second-child");
    expect(meta.queue).toContain("worker");
    expect(meta.queue).toContain("notifications");
  });
});

describe("with workers", () => {
  afterEach(async () => {
    await api.resque.stopWorkers();
    await api.resque.stopScheduler();
  }, HOOK_TIMEOUT);

  test("fanned-out jobs are processed and results collected", async () => {
    const inputs = [{ itemId: "x" }, { itemId: "y" }, { itemId: "z" }];
    const result = await api.actions.fanOut("fanout:child", inputs);

    await api.resque.startWorkers();
    await waitFor(async () => {
      const s = await api.actions.fanOutStatus(result.fanOutId);
      return s.completed + s.failed >= 3;
    });

    const status = await api.actions.fanOutStatus(result.fanOutId);
    expect(status.total).toBe(3);
    expect(status.completed).toBe(3);
    expect(status.failed).toBe(0);
    expect(status.results).toHaveLength(3);

    const processedIds = status.results.map((r) => r.result.processed).sort();
    expect(processedIds).toEqual(["x", "y", "z"]);
  });

  test("multi-action fan-out jobs are processed and results collected", async () => {
    const result = await api.actions.fanOut([
      { action: "fanout:child", inputs: { itemId: "m1" } },
      { action: "fanout:child", inputs: { itemId: "m2" } },
      { action: "fanout:second-child", inputs: { name: "grace" } },
    ]);

    await api.resque.startWorkers();
    await waitFor(async () => {
      const s = await api.actions.fanOutStatus(result.fanOutId);
      return s.completed + s.failed >= 3;
    });

    const status = await api.actions.fanOutStatus(result.fanOutId);
    expect(status.total).toBe(3);
    expect(status.completed).toBe(3);
    expect(status.failed).toBe(0);
    expect(status.results).toHaveLength(3);

    // Results from both action types should be present
    const childResults = status.results.filter((r) => r.result.processed);
    const secondResults = status.results.filter((r) => r.result.greeted);
    expect(childResults).toHaveLength(2);
    expect(secondResults).toHaveLength(1);
    expect(secondResults[0].result.greeted).toBe("grace");
  });

  test("failed child jobs have errors collected", async () => {
    const inputs = [{ itemId: "fail-1" }, { itemId: "fail-2" }];
    const result = await api.actions.fanOut("fanout:failing-child", inputs);

    await api.resque.startWorkers();
    await waitFor(async () => {
      const s = await api.actions.fanOutStatus(result.fanOutId);
      return s.completed + s.failed >= 2;
    });

    const status = await api.actions.fanOutStatus(result.fanOutId);
    expect(status.total).toBe(2);
    expect(status.completed).toBe(0);
    expect(status.failed).toBe(2);
    expect(status.errors).toHaveLength(2);

    for (const err of status.errors) {
      expect(err.error).toContain("failed processing");
    }
  });
});

describe("fanOut overload types (compile-time)", () => {
  test("both overload shapes type-check and bad shapes are rejected", () => {
    // These calls are never awaited — the suite exists purely to lock in
    // the overload contract. If the overloads regress to a flat union,
    // the @ts-expect-error lines below will start failing.
    const _never = async () => {
      // Good: single-action form
      await api.actions.fanOut("fanout:child", [{ itemId: "1" }]);
      await api.actions.fanOut("fanout:child", [{ itemId: "1" }], "worker");
      await api.actions.fanOut("fanout:child", [{ itemId: "1" }], "worker", {
        resultTtl: 30,
      });

      // Good: multi-action form
      await api.actions.fanOut([{ action: "fanout:child" }]);
      await api.actions.fanOut(
        [{ action: "fanout:child", inputs: { itemId: "1" } }],
        { resultTtl: 30 },
      );

      // Bad: single-action form can't take FanOutOptions in the inputsArray slot
      // @ts-expect-error - options is not a TaskInputs[]
      await api.actions.fanOut("fanout:child", { resultTtl: 30 });

      // Bad: multi-action form can't take a queue string in the options slot
      // @ts-expect-error - "worker" is not a FanOutOptions
      await api.actions.fanOut([{ action: "fanout:child" }], "worker");
    };
    expect(typeof _never).toBe("function");
  });
});

describe("onEnqueue hook in fanOut", () => {
  afterEach(() => {
    const hooksInitializer = api.initializers.find((i) => i.name === "hooks");
    (hooksInitializer as any).actionsOnEnqueue.clear();
  });

  test("fires once per child job in a fan-out batch", async () => {
    const calls: Array<{ actionName: string; queue: string }> = [];
    api.hooks.actions.onEnqueue((actionName, _inputs, queue) => {
      calls.push({ actionName, queue });
    });

    await api.actions.fanOut("fanout:child", [
      { itemId: "1" },
      { itemId: "2" },
      { itemId: "3" },
    ]);

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.actionName === "fanout:child")).toBe(true);
    expect(calls.every((c) => c.queue === "worker")).toBe(true);
  });

  test("returned inputs from hook land in each child job payload", async () => {
    api.hooks.actions.onEnqueue((_name, inputs) => ({
      ...inputs,
      injected: true,
    }));

    await api.actions.fanOut("fanout:child", [
      { itemId: "a" },
      { itemId: "b" },
    ]);

    const jobs = await api.actions.queued("worker");
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.args[0].injected).toBe(true);
    }
  });
});
