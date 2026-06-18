import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Action } from "keryx";
import { api, config } from "keryx";
import { z } from "zod";
import { HOOK_TIMEOUT, waitFor } from "../setup";
import { computeStats, printStats } from "./stats";

// ---------------------------------------------------------------------------
// Stress thresholds
// ---------------------------------------------------------------------------
const STRESS = {
  workers: 8,
  // Single fan-out
  childCount: 500,
  drainTimeoutMs: 60_000,
  // Mixed batches
  mixedSuccessCount: 250,
  mixedFailureCount: 250,
  // Many concurrent fan-outs
  concurrentFanOuts: 50,
  childrenPerFanOut: 10,
};

// ---------------------------------------------------------------------------
// Stress actions
// ---------------------------------------------------------------------------
const STRESS_QUEUE = "bench-stress";
const STRESS_CHILD = "bench-stress:child";
const STRESS_FAILING = "bench-stress:failing";

const processedIds: string[] = [];

const childInputs = z.object({
  itemId: z.string(),
  _fanOutId: z.string().optional(),
});

class StressChildAction implements Action {
  name = STRESS_CHILD;
  inputs = childInputs;
  task = { queue: STRESS_QUEUE };
  run = async (params: z.infer<typeof childInputs>) => {
    processedIds.push(params.itemId);
    return { processed: params.itemId };
  };
}

class FailingStressChildAction implements Action {
  name = STRESS_FAILING;
  inputs = childInputs;
  task = { queue: STRESS_QUEUE };
  run = async (params: z.infer<typeof childInputs>) => {
    throw new Error(`stress-fail ${params.itemId}`);
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("fanOut stress benchmarks", () => {
  let originalProcessors: number;

  beforeAll(async () => {
    originalProcessors = config.tasks.taskProcessors;
    config.tasks.taskProcessors = STRESS.workers;
    await api.start();

    // Register stress actions and wrap them as resque jobs so the
    // already-running workers can dispatch them.
    const child = new StressChildAction();
    api.actions.actions.push(child);
    api.resque.jobs[child.name] = api.resque.wrapActionAsJob(child);

    const failing = new FailingStressChildAction();
    api.actions.actions.push(failing);
    api.resque.jobs[failing.name] = api.resque.wrapActionAsJob(failing);

    // Workers were constructed during api.start() before the stress jobs
    // were registered. Cycle them so they pick up the new jobs map.
    await api.resque.stopWorkers();
    await api.resque.startWorkers();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    api.actions.actions = api.actions.actions.filter(
      (a) => a.name !== STRESS_CHILD && a.name !== STRESS_FAILING,
    );
    delete api.resque.jobs[STRESS_CHILD];
    delete api.resque.jobs[STRESS_FAILING];

    await api.stop();
    config.tasks.taskProcessors = originalProcessors;
  }, HOOK_TIMEOUT);

  test(
    `benchmark: ${STRESS.childCount} children dispatched and collected with no drops`,
    async () => {
      processedIds.length = 0;

      const inputs = Array.from({ length: STRESS.childCount }, (_, i) => ({
        itemId: `item-${i}`,
      }));
      const expectedIds = new Set(inputs.map((i) => i.itemId));

      const start = performance.now();
      const result = await api.actions.fanOut(STRESS_CHILD, inputs);

      await waitFor(
        async () => {
          const s = await api.actions.fanOutStatus(result.fanOutId);
          return s.completed + s.failed >= STRESS.childCount;
        },
        { interval: 25, timeout: STRESS.drainTimeoutMs },
      );
      const elapsed = performance.now() - start;

      const status = await api.actions.fanOutStatus(result.fanOutId);

      printStats(
        `fanOut (${STRESS.childCount} children, ${STRESS.workers} workers)`,
        computeStats([elapsed]),
      );

      expect(result.enqueued).toBe(STRESS.childCount);
      expect(result.errors).toHaveLength(0);
      expect(status.total).toBe(STRESS.childCount);
      expect(status.completed).toBe(STRESS.childCount);
      expect(status.failed).toBe(0);
      expect(status.results).toHaveLength(STRESS.childCount);

      // No drops, no dupes: every input id appears exactly once in results.
      const collectedIds = new Set(
        status.results.map((r) => r.params.itemId as string),
      );
      expect(collectedIds.size).toBe(STRESS.childCount);
      for (const id of expectedIds) expect(collectedIds.has(id)).toBe(true);

      // Worker-side bookkeeping matches.
      expect(processedIds).toHaveLength(STRESS.childCount);
      expect(new Set(processedIds).size).toBe(STRESS.childCount);
    },
    { timeout: 120_000 },
  );

  test(
    "benchmark: mixed success/failure batches accounted with no cross-batch leakage",
    async () => {
      const successInputs = Array.from(
        { length: STRESS.mixedSuccessCount },
        (_, i) => ({ itemId: `ok-${i}` }),
      );
      const failureInputs = Array.from(
        { length: STRESS.mixedFailureCount },
        (_, i) => ({ itemId: `bad-${i}` }),
      );

      const [okResult, failResult] = await Promise.all([
        api.actions.fanOut(STRESS_CHILD, successInputs),
        api.actions.fanOut(STRESS_FAILING, failureInputs),
      ]);

      await Promise.all([
        waitFor(
          async () => {
            const s = await api.actions.fanOutStatus(okResult.fanOutId);
            return s.completed + s.failed >= STRESS.mixedSuccessCount;
          },
          { interval: 25, timeout: STRESS.drainTimeoutMs },
        ),
        waitFor(
          async () => {
            const s = await api.actions.fanOutStatus(failResult.fanOutId);
            return s.completed + s.failed >= STRESS.mixedFailureCount;
          },
          { interval: 25, timeout: STRESS.drainTimeoutMs },
        ),
      ]);

      const okStatus = await api.actions.fanOutStatus(okResult.fanOutId);
      const failStatus = await api.actions.fanOutStatus(failResult.fanOutId);

      expect(okStatus.total).toBe(STRESS.mixedSuccessCount);
      expect(okStatus.completed).toBe(STRESS.mixedSuccessCount);
      expect(okStatus.failed).toBe(0);
      expect(okStatus.results).toHaveLength(STRESS.mixedSuccessCount);

      expect(failStatus.total).toBe(STRESS.mixedFailureCount);
      expect(failStatus.completed).toBe(0);
      expect(failStatus.failed).toBe(STRESS.mixedFailureCount);
      expect(failStatus.errors).toHaveLength(STRESS.mixedFailureCount);

      // No cross-batch leakage: each fan-out's collected entries match its total.
      expect(okStatus.results.length + okStatus.errors.length).toBe(
        okStatus.total,
      );
      expect(failStatus.results.length + failStatus.errors.length).toBe(
        failStatus.total,
      );

      // Inputs in each batch are distinct from the other batch.
      const okIds = new Set(
        okStatus.results.map((r) => r.params.itemId as string),
      );
      const failIds = new Set(
        failStatus.errors.map((e) => e.params.itemId as string),
      );
      for (const id of okIds) expect(id.startsWith("ok-")).toBe(true);
      for (const id of failIds) expect(id.startsWith("bad-")).toBe(true);
    },
    { timeout: 120_000 },
  );

  test(
    `benchmark: ${STRESS.concurrentFanOuts} concurrent fanOut calls don't lose dispatches`,
    async () => {
      const batches = Array.from({ length: STRESS.concurrentFanOuts }, (_, b) =>
        Array.from({ length: STRESS.childrenPerFanOut }, (_, i) => ({
          itemId: `b${b}-i${i}`,
        })),
      );

      const results = await Promise.all(
        batches.map((inputs) => api.actions.fanOut(STRESS_CHILD, inputs)),
      );

      await Promise.all(
        results.map((r) =>
          waitFor(
            async () => {
              const s = await api.actions.fanOutStatus(r.fanOutId);
              return s.completed + s.failed >= STRESS.childrenPerFanOut;
            },
            { interval: 25, timeout: STRESS.drainTimeoutMs },
          ),
        ),
      );

      for (const r of results) {
        const s = await api.actions.fanOutStatus(r.fanOutId);
        expect(s.total).toBe(STRESS.childrenPerFanOut);
        expect(s.completed).toBe(STRESS.childrenPerFanOut);
        expect(s.failed).toBe(0);
        expect(s.results).toHaveLength(STRESS.childrenPerFanOut);
      }
    },
    { timeout: 120_000 },
  );
});
