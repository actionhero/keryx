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
import { Action, api, config, logger, RUN_MODE } from "../../api";
import { HOOK_TIMEOUT, waitFor } from "./../setup";

// node-resque-specific behavior (Redis internals, worker events). Skipped unless the
// node-resque backend is active, since these assertions have no meaning on other backends.
const describeNodeResque = describe.skipIf(
  config.tasks.backend !== "node-resque",
);

async function startInitializer(name: string) {
  const initializer = api.initializers.find((i) => i.name === name);
  // @ts-ignore — start() exists on the concrete initializer
  await initializer.start();
}

const testActionInputs = z.object({ val: z.string().default("I ran") });

class TestAction implements Action {
  name = "test_action";
  inputs = testActionInputs;
  run = async (): Promise<void> => {};
}

describeNodeResque("node-resque backend", () => {
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
    await api.redis.redis.flushdb();
    api.actions.actions = api.actions.actions.filter(
      (a) => a.name !== "test_action",
    );
    const instance = new TestAction();
    api.actions.actions.push(instance);
    api.tasks.registerAction(instance);
  });

  afterEach(() => {
    api.actions.actions = api.actions.actions.filter(
      (a) => a.name !== "test_action",
    );
    api.tasks.unregisterAction("test_action");
  });

  describe("cleaning_worker event handler (issue #464)", () => {
    afterEach(async () => {
      await api.tasks.stopWorkers();
    });

    test("logs worker name and pid from the cleaning_worker event", async () => {
      const logged: string[] = [];
      const originalDebug = logger.debug;
      logger.debug = ((msg: string) => logged.push(msg)) as typeof logger.debug;

      try {
        await api.tasks.startWorkers();
        const worker = api.resque!.workers[0];
        worker.emit("cleaning_worker", worker, "12345");

        const match = logged.find((m) => m.includes("cleaning worker"));
        expect(match).toBeDefined();
        expect(match).toContain("cleaning worker");
        expect(match).toContain("12345");
      } finally {
        logger.debug = originalDebug;
      }
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
});
