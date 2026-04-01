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
});
