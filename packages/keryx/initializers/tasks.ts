import { type Action, api, CONNECTION_TYPE, Connection, config } from "../api";
import { NodeResqueBackend } from "../backends/NodeResqueBackend";
import { PgBossBackend } from "../backends/PgBossBackend";
import { PgFanOutStore } from "../backends/PgFanOutStore";
import { RedisFanOutStore } from "../backends/RedisFanOutStore";
import type { FanOutStore } from "../classes/FanOutStore";
import { Initializer } from "../classes/Initializer";
import {
  type TaskBackend,
  type TaskInputs,
  type TaskRunner,
} from "../classes/TaskBackend";
import { ErrorType, TypedError } from "../classes/TypedError";

const namespace = "tasks";

/**
 * Per-job context passed to {@link BeforeJobHook} and {@link AfterJobHook}.
 * The same object instance is threaded from `beforeJob` to `afterJob`, so hooks can
 * stash span refs, timing data, or any other state in `metadata`.
 */
export interface JobContext {
  /** The queue this job was pulled from. */
  queue: string;
  /** Mutable scratch space shared between `beforeJob` and `afterJob`. */
  metadata: Record<string, unknown>;
}

/**
 * Unified outcome passed to {@link AfterJobHook}. Discriminate via the `success` field.
 * Covers both the success and failure paths in a single shape.
 */
export type JobOutcome =
  | { success: true; result: unknown; duration: number }
  | { success: false; error: unknown; duration: number };

/**
 * Runs inside the task runner immediately before the action executes (i.e. before
 * `connection.act()`). Receives the action name and decoded params, giving plugins
 * access to trace headers or other correlation data embedded in inputs. Hooks run
 * sequentially in registration order. Throwing fails the job.
 */
export type BeforeJobHook = (
  actionName: string,
  params: TaskInputs,
  ctx: JobContext,
) => Promise<void> | void;

/**
 * Runs inside the task runner after the action executes, in a `finally` block so it
 * fires for both success and failure. Receives the same `ctx` passed to `beforeJob`
 * plus a {@link JobOutcome} describing what happened. Hooks run sequentially in
 * registration order. Errors thrown by an `afterJob` hook do not mask an action
 * error but may surface instead of it if the action succeeded.
 */
export type AfterJobHook = (
  actionName: string,
  params: TaskInputs,
  ctx: JobContext,
  outcome: JobOutcome,
) => Promise<void> | void;

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Tasks["initialize"]>>;
    /**
     * @deprecated Use `api.tasks.backend` instead. Retained for one minor version as an
     * alias to the node-resque backend. Only present when `config.tasks.backend === "node-resque"`;
     * `undefined` under any other backend.
     */
    resque: NodeResqueBackend | undefined;
  }
}

let SERVER_JOB_COUNTER = 1;

/**
 * Build the shared task runner: the single place that owns a task's execution lifecycle,
 * independent of which queue backend dispatched it. Every backend's job handler calls this.
 *
 * It creates a fresh `"task"`-typed {@link Connection} with an empty in-memory session (tasks are
 * fresh starts — needed data must arrive via params, not session state), runs the `beforeJob`
 * hooks, executes the action via `connection.act()`, records fan-out results/errors through the
 * {@link FanOutStore}, runs the `afterJob` hooks, and re-enqueues recurring actions. Resolves with
 * the action response on success and re-throws on failure so the backend can mark the job failed.
 */
function makeTaskRunner(fanOutStore: FanOutStore): TaskRunner {
  return async function runTask(
    actionName: string,
    inputs: TaskInputs,
    ctx: { queue: string },
  ) {
    const action = api.actions.actions.find((a) => a.name === actionName);
    if (!action) {
      throw new TypedError({
        message: `action ${actionName} not found`,
        type: ErrorType.CONNECTION_TASK_DEFINITION,
      });
    }

    const propagatedCorrelationId = inputs._correlationId as string | undefined;

    const connection = new Connection(
      CONNECTION_TYPE.TASK,
      `job:${api.process.name}:${SERVER_JOB_COUNTER++}`,
    );
    if (propagatedCorrelationId) {
      connection.correlationId = propagatedCorrelationId;
    }
    // Synthesize an empty session in-memory — tasks are fresh starts; needed data
    // must come through action params, not session state.
    connection.session = {
      id: `task:${connection.id}`,
      cookieName: config.session.cookieName,
      createdAt: Date.now(),
      data: {},
    };
    connection.sessionLoaded = true;

    const fanOutId = inputs._fanOutId as string | undefined;
    const jobCtx: JobContext = { queue: ctx.queue, metadata: {} };
    const jobStartTime = Date.now();

    let response: unknown;
    let error: unknown;
    let outcome: JobOutcome | undefined;
    try {
      for (const hook of api.hooks.resque.beforeJobHooks) {
        await hook(actionName, inputs, jobCtx);
      }
      const payload = await connection.act(actionName, inputs);
      response = payload.response;
      error = payload.error;

      if (error) throw error;
      outcome = {
        success: true,
        result: response,
        duration: Date.now() - jobStartTime,
      };
    } catch (e) {
      outcome = {
        success: false,
        error: e,
        duration: Date.now() - jobStartTime,
      };
      // Collect fan-out error before re-throwing.
      if (fanOutId) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        await fanOutStore.recordError(fanOutId, inputs, errorMessage);
      }
      throw e;
    } finally {
      if (outcome) {
        for (const hook of api.hooks.resque.afterJobHooks) {
          await hook(actionName, inputs, jobCtx, outcome);
        }
      }
      if (action.task && action.task.frequency && action.task.frequency > 0) {
        await api.actions.enqueueRecurrent(action);
      }
    }

    // Collect fan-out result on success.
    if (fanOutId) {
      await fanOutStore.recordResult(fanOutId, inputs, response);
    }

    return response;
  };
}

/** Instantiate the configured queue backend. */
function buildBackend(taskRunner: TaskRunner): TaskBackend {
  switch (config.tasks.backend) {
    case "node-resque":
      return new NodeResqueBackend(taskRunner);
    case "pg-boss":
      return new PgBossBackend(taskRunner);
    default:
      throw new TypedError({
        type: ErrorType.SERVER_INITIALIZATION,
        message: `unknown tasks backend "${config.tasks.backend}" (expected "node-resque" or "pg-boss")`,
      });
  }
}

/** Instantiate the configured fan-out store. */
function buildFanOutStore(): FanOutStore {
  switch (config.tasks.fanOutStore) {
    case "redis":
      return new RedisFanOutStore();
    case "postgres":
      return new PgFanOutStore();
    default:
      throw new TypedError({
        type: ErrorType.SERVER_INITIALIZATION,
        message: `unknown tasks fan-out store "${config.tasks.fanOutStore}" (expected "redis" or "postgres")`,
      });
  }
}

/**
 * Initializer for the pluggable background task system. Selects a {@link TaskBackend} and
 * {@link FanOutStore} from `config.tasks` at boot, wires them to the shared task runner, and
 * exposes them as `api.tasks.backend` / `api.tasks.fanOutStore`. The public task interface lives
 * on `api.actions.*`; this initializer is the seam beneath it.
 */
export class Tasks extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["redis", "db", "actions", "process", "hooks"];
  }

  async initialize() {
    const fanOutStore = buildFanOutStore();
    const taskRunner = makeTaskRunner(fanOutStore);
    const backend = buildBackend(taskRunner);

    // Retain `api.resque` as a deprecated alias to the node-resque backend for one minor
    // version. It exposes node-resque internals (queue/scheduler/workers/jobs) that the
    // `resque-admin` plugin and legacy code still read directly.
    api.resque = backend instanceof NodeResqueBackend ? backend : undefined;

    return {
      /** The active queue backend. */
      backend,
      /** The active fan-out store. */
      fanOutStore,
      /** The shared task runner (executes an action inside a fresh task connection). */
      runTask: taskRunner,
      /** Start the worker pool. */
      startWorkers: () => backend.startWorkers(),
      /** Stop the worker pool. */
      stopWorkers: () => backend.stopWorkers(),
      /** Start the scheduler. */
      startScheduler: () => backend.startScheduler(),
      /** Stop the scheduler. */
      stopScheduler: () => backend.stopScheduler(),
      /** Register an action with the backend (used when actions are added at runtime, e.g. tests). */
      registerAction: (action: Action) => backend.registerAction(action),
      /** Unregister an action from the backend. */
      unregisterAction: (actionName: string) =>
        backend.unregisterAction(actionName),
    };
  }

  async start() {
    await api.tasks.fanOutStore.start();
    await api.tasks.backend.start(api.runMode);
  }

  async stop() {
    await api.tasks.backend.stop(api.runMode);
    await api.tasks.fanOutStore.stop();
  }
}
