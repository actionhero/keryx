import { randomUUID } from "crypto";
import path from "path";
import { api, logger } from "../api";
import { type Action, DEFAULT_QUEUE } from "../classes/Action";
import { Initializer } from "../classes/Initializer";
import { Router } from "../classes/Router";
import type { FailedJob, TaskInputs } from "../classes/TaskBackend";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import { formatLoadedMessage } from "../util/config";
import { globLoader } from "../util/glob";

export type { TaskInputs };

const namespace = "actions";

/** A single job descriptor for multi-action fan-out. */
export type FanOutJob = {
  /** The action name to enqueue. */
  action: string;
  /** Inputs to pass to the action. Defaults to `{}`. */
  inputs?: TaskInputs;
  /** Override the queue for this specific job. Falls back to the action's configured queue. */
  queue?: string;
};

/** Options for controlling fan-out behavior. */
export type FanOutOptions = {
  /** Max jobs to enqueue per Redis batch. Defaults to `config.actions.fanOutBatchSize`. */
  batchSize?: number;
  /** TTL in seconds for the fan-out metadata and result keys in Redis. Defaults to `config.actions.fanOutResultTtl`. */
  resultTtl?: number;
  /** Correlation ID to propagate to all child jobs for distributed tracing. Injected as `_correlationId` in each job's inputs. */
  correlationId?: string;
};

/** Returned immediately from `fanOut()` with metadata about the enqueue operation. */
export type FanOutResult = {
  /** Unique ID for querying status later via `fanOutStatus()`. */
  fanOutId: string;
  /** The action name(s) that were fanned out. */
  actionName: string | string[];
  /** The queue(s) jobs were enqueued to. */
  queue: string | string[];
  /** Number of jobs successfully enqueued. */
  enqueued: number;
  /** Any enqueue-time failures, with the index of the failed job. */
  errors: Array<{ index: number; error: string }>;
};

/** Status of a fan-out operation, as returned by `fanOutStatus()`. */
export type FanOutStatus = {
  /** Total number of jobs in this fan-out batch. */
  total: number;
  /** Number of jobs that have completed successfully. */
  completed: number;
  /** Number of jobs that have failed. */
  failed: number;
  /** Collected results from completed child jobs. */
  results: Array<{ params: Record<string, any>; result: any }>;
  /** Collected errors from failed child jobs. */
  errors: Array<{ params: Record<string, any>; error: string }>;
};

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Actions["initialize"]>>;
  }
}

/**
 * Runs when any action is enqueued — via {@link Actions.enqueue}, {@link Actions.enqueueAt},
 * {@link Actions.enqueueIn}, or the per-job calls inside {@link Actions.fanOut}. Fires after
 * the queue has been resolved and before the job is placed in Redis.
 *
 * Return a new `TaskInputs` object to replace the payload (e.g. to inject trace headers),
 * or return `void` / `undefined` to leave the payload unchanged. If multiple hooks are
 * registered they run sequentially in registration order; each receives the output of
 * the previous one.
 *
 * Register via `api.hooks.actions.onEnqueue(...)`.
 */
export type OnEnqueueHook = (
  actionName: string,
  inputs: TaskInputs,
  queue: string,
) => Promise<TaskInputs | void> | TaskInputs | void;

export class Actions extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["hooks"];
  }

  /** Run all registered `onEnqueue` hooks, threading inputs through each. */
  private runOnEnqueueHooks = async (
    actionName: string,
    inputs: TaskInputs,
    queue: string,
  ): Promise<TaskInputs> => {
    let current = inputs;
    for (const hook of api.hooks.actions.onEnqueueHooks) {
      const next = await hook(actionName, current, queue);
      if (next !== undefined) current = next;
    }
    return current;
  };

  /**
   * Enqueue an action to be performed in the background.
   *
   * @param actionName - The name of the action to enqueue.
   * @param inputs - Inputs to pass to the action. Defaults to `{}`.
   * @param queue - Which queue to enqueue on. Falls back to the action's configured queue, then `"default"`.
   * @throws {TypedError} With `ErrorType.CONNECTION_TASK_DEFINITION` if the action is not found.
   */
  enqueue = async (
    actionName: string,
    inputs: TaskInputs = {},
    queue?: string,
  ) => {
    const action = api.actions.actions.find(
      (a: Action) => a.name === actionName,
    );
    if (!action) {
      throw new TypedError({
        message: `action ${actionName} not found`,
        type: ErrorType.CONNECTION_TASK_DEFINITION,
      });
    }
    queue = queue ?? action?.task?.queue ?? DEFAULT_QUEUE;
    const finalInputs = await this.runOnEnqueueHooks(actionName, inputs, queue);
    return api.tasks.backend.enqueue(queue, actionName, finalInputs);
  };

  /**
   * Fan out work to many child jobs for parallel processing.
   * Enqueues one job per item, injects `_fanOutId` into each,
   * and stores metadata in Redis for result collection.
   *
   * @returns A {@link FanOutResult} containing the `fanOutId` for later
   *   status queries via {@link fanOutStatus}.
   * @throws {TypedError} With `ErrorType.CONNECTION_TASK_DEFINITION` if any
   *   referenced action is not registered.
   */
  fanOut: {
    /**
     * Single-action form: enqueue one job per entry in `inputsArray`, all for the same action.
     *
     * @param actionName - Name of the action to enqueue for every job.
     * @param inputsArray - One input object per child job. An empty array is allowed.
     * @param queue - Optional queue override for every job. Falls back to the action's configured queue, then `DEFAULT_QUEUE`.
     * @param options - Fan-out options (batch size, result TTL, correlation ID).
     */
    (
      actionName: string,
      inputsArray: TaskInputs[],
      queue?: string,
      options?: FanOutOptions,
    ): Promise<FanOutResult>;

    /**
     * Multi-action form: enqueue heterogeneous jobs, each with its own action and optional queue override.
     *
     * @param jobs - Job descriptors. Each entry must reference a registered action.
     * @param options - Fan-out options (batch size, result TTL, correlation ID).
     */
    (jobs: FanOutJob[], options?: FanOutOptions): Promise<FanOutResult>;
  } = async (
    actionNameOrJobs: string | FanOutJob[],
    inputsArrayOrOptions?: TaskInputs[] | FanOutOptions,
    queue?: string,
    options?: FanOutOptions,
  ): Promise<FanOutResult> => {
    // Normalize both call signatures into a unified jobs array
    let jobs: FanOutJob[];
    let resolvedOptions: FanOutOptions;

    if (typeof actionNameOrJobs === "string") {
      // Single-action form: fanOut(actionName, inputsArray, queue?, options?)
      const actionName = actionNameOrJobs;
      const inputsArray = (inputsArrayOrOptions as TaskInputs[]) ?? [];
      resolvedOptions = options ?? {};
      jobs = inputsArray.map((inputs) => ({
        action: actionName,
        inputs,
        queue,
      }));
    } else {
      // Multi-action form: fanOut(jobs[], options?)
      jobs = actionNameOrJobs;
      resolvedOptions = (inputsArrayOrOptions as FanOutOptions) ?? {};
    }

    // Validate all action names up front
    const actionNames = new Set<string>();
    for (const job of jobs) {
      const action = api.actions.actions.find(
        (a: Action) => a.name === job.action,
      );
      if (!action) {
        throw new TypedError({
          message: `action ${job.action} not found`,
          type: ErrorType.CONNECTION_TASK_DEFINITION,
        });
      }
      actionNames.add(job.action);
    }

    // Resolve queue per job: explicit job.queue > action's task.queue > DEFAULT_QUEUE
    const resolvedJobs = jobs.map((job) => {
      const action = api.actions.actions.find(
        (a: Action) => a.name === job.action,
      )!;
      const resolvedQueue = job.queue ?? action?.task?.queue ?? DEFAULT_QUEUE;
      return { ...job, queue: resolvedQueue, inputs: job.inputs ?? {} };
    });

    const batchSize =
      resolvedOptions.batchSize ?? config.actions.fanOutBatchSize;
    const resultTtl =
      resolvedOptions.resultTtl ?? config.actions.fanOutResultTtl;
    const fanOutId = randomUUID();

    // Collect unique queues used
    const queuesUsed = [...new Set(resolvedJobs.map((j) => j.queue))];
    const actionNamesList = [...actionNames];

    // Initialize fan-out tracking in the configured store.
    await api.tasks.fanOutStore.create(
      fanOutId,
      resolvedJobs.length,
      actionNamesList,
      queuesUsed,
      resultTtl,
    );

    const enqueueErrors: Array<{ index: number; error: string }> = [];
    let enqueued = 0;

    // Enqueue in batches to avoid flooding Redis
    for (let i = 0; i < resolvedJobs.length; i += batchSize) {
      const batch = resolvedJobs.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((job) => {
          const enrichedInputs = {
            ...job.inputs,
            _fanOutId: fanOutId,
            ...(resolvedOptions.correlationId
              ? { _correlationId: resolvedOptions.correlationId }
              : {}),
          };
          return this.enqueue(job.action, enrichedInputs, job.queue);
        }),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          enqueued++;
        } else {
          enqueueErrors.push({
            index: i + j,
            error: String(result.reason),
          });
        }
      }
    }

    return {
      fanOutId,
      actionName:
        actionNamesList.length === 1 ? actionNamesList[0] : actionNamesList,
      queue: queuesUsed.length === 1 ? queuesUsed[0] : queuesUsed,
      enqueued,
      errors: enqueueErrors,
    };
  };

  /**
   * Query the status of a fan-out operation.
   * Returns totals, collected results, and errors.
   */
  fanOutStatus = async (fanOutId: string): Promise<FanOutStatus> => {
    return api.tasks.fanOutStore.read(fanOutId);
  };

  /**
   * Enqueue an action to run at a specific time in the future.
   *
   * @param timestamp - Epoch timestamp (ms) when the task becomes eligible to run.
   *   Does not guarantee the task will run at exactly this time.
   * @param actionName - The name of the action to enqueue.
   * @param inputs - Inputs to pass to the action.
   * @param queue - Which queue to enqueue on. Defaults to `"default"`.
   * @param suppressDuplicateTaskError - If `true`, silently ignore errors when the same
   *   task with the same arguments is already enqueued for the same time.
   */
  enqueueAt = async (
    timestamp: number,
    actionName: string,
    inputs: TaskInputs = {},
    queue: string = DEFAULT_QUEUE,
    suppressDuplicateTaskError = false,
  ) => {
    const finalInputs = await this.runOnEnqueueHooks(actionName, inputs, queue);
    return api.tasks.backend.enqueueAt(
      timestamp,
      queue,
      actionName,
      finalInputs,
      suppressDuplicateTaskError,
    );
  };

  /**
   * Enqueue an action to run after a delay (in milliseconds from now).
   *
   * @param time - Delay in milliseconds before the task becomes eligible to run.
   * @param actionName - The name of the action to enqueue.
   * @param inputs - Inputs to pass to the action.
   * @param queue - Which queue to enqueue on. Defaults to `"default"`.
   * @param suppressDuplicateTaskError - If `true`, silently ignore errors when the same
   *   task with the same arguments is already enqueued for the same time.
   */
  enqueueIn = async (
    time: number,
    actionName: string,
    inputs: TaskInputs = {},
    queue: string = DEFAULT_QUEUE,
    suppressDuplicateTaskError = false,
  ) => {
    const finalInputs = await this.runOnEnqueueHooks(actionName, inputs, queue);
    return api.tasks.backend.enqueueIn(
      time,
      queue,
      actionName,
      finalInputs,
      suppressDuplicateTaskError,
    );
  };

  /**
   * Delete a previously enqueued task that hasn't been run yet.
   *
   * @param queue - The queue the task is stored on.
   * @param actionName - The name of the job to delete.
   * @param args - The arguments of the job to match. Note: arguments may have been modified
   *   during enqueuing — read job properties via `api.actions.queued` first.
   * @param count - Up to how many matching jobs to delete (0-indexed). Default: 0.
   */
  del = async (
    queue: string,
    actionName: string,
    args?: TaskInputs,
    count?: number,
  ) => {
    return api.tasks.backend.del(queue, actionName, args, count);
  };

  /**
   * Delete all jobs of a given action name from a queue. Does not affect delayed queues,
   * and will not prevent new jobs from being added while running.
   *
   * @param queue - The queue to delete from.
   * @param actionName - The action name whose jobs to remove.
   * @param start - Starting position (0-indexed) of the range to remove.
   * @param stop - Stop position (0-indexed) of the range to remove.
   * @remarks node-resque-specific; returns `0` on backends that don't support it.
   */
  delByFunction = async (
    queue: string,
    actionName: string,
    start?: number,
    stop?: number,
  ) => {
    return (
      (await api.tasks.backend.delByFunction?.(
        queue,
        actionName,
        start,
        stop,
      )) ?? 0
    );
  };

  /**
   * Delete all delayed instances of a task across all future timestamps.
   *
   * @param queue - The queue the task is stored on.
   * @param actionName - The action name to delete.
   * @param inputs - The job arguments to match. Arguments may have been modified during
   *   enqueuing — read properties via `api.actions.delayedAt` first.
   */
  delDelayed = async (
    queue: string,
    actionName: string,
    inputs?: TaskInputs,
  ) => {
    return api.tasks.backend.delDelayed(queue, actionName, inputs);
  };

  /**
   * Return the timestamps at which a task is scheduled to run.
   *
   * @param queue - The queue the task is stored on.
   * @param actionName - The action name to look up.
   * @param inputs - The job arguments to match.
   * @returns Array of epoch timestamps (ms) when the job is scheduled.
   */
  scheduledAt = async (
    queue: string,
    actionName: string,
    inputs: TaskInputs,
  ): Promise<Array<number>> => {
    return api.tasks.backend.scheduledAt(queue, actionName, inputs);
  };

  /**
   * Return backend-wide task stats (how jobs failed, jobs succeeded, etc).
   * Will throw an error if the backend cannot be reached.
   */
  resqueStats = async () => {
    return api.tasks.backend.stats();
  };

  /**
   * Retrieve details of jobs enqueued on a queue (0-indexed range).
   *
   * @param queue - The queue name. Defaults to `"default"`.
   * @param start - Starting index. Defaults to 0.
   * @param stop - Ending index. Defaults to 100.
   * @returns Array of job input objects.
   */
  queued = (
    queue: string = DEFAULT_QUEUE,
    start: number = 0,
    stop: number = 100,
  ): Promise<Array<TaskInputs>> => {
    return api.tasks.backend.queued(queue, start, stop);
  };

  /**
   * Delete a queue and all jobs stored on it.
   * Will throw an error if the backend cannot be reached.
   * @remarks node-resque-specific; a no-op on backends that don't support it.
   */
  delQueue = async (q: string) => {
    return api.tasks.backend.delQueue?.(q);
  };

  /**
   * Return any locks, as created by resque plugins or task middleware, in this namespace.
   * Will contain locks with keys like `resque:lock:{job}` and `resque:workerslock:{workerId}`
   * Will throw an error if the backend cannot be reached.
   * @remarks node-resque-specific; returns `{}` on backends that don't support it.
   */
  locks = async () => {
    return (await api.tasks.backend.locks?.()) ?? {};
  };

  /**
   * Delete a lock on a job or worker.  Locks can be found via `api.actions.locks`
   * Will throw an error if the backend cannot be reached.
   * @remarks node-resque-specific; returns `0` on backends that don't support it.
   */
  delLock = async (lock: string) => {
    return (await api.tasks.backend.delLock?.(lock)) ?? 0;
  };

  /**
   * List all timestamps for which tasks are enqueued in the future, via `api.actions.enqueueIn` or `api.actions.enqueueAt`
   * Will throw an error if the backend cannot be reached.
   * @remarks node-resque-specific; returns `[]` on backends that don't support it.
   */
  timestamps = async (): Promise<Array<number>> => {
    return (await api.tasks.backend.timestamps?.()) ?? [];
  };

  /**
   * Return all jobs which have been enqueued to run at a certain timestamp.
   * Will throw an error if the backend cannot be reached.
   * @remarks node-resque-specific; returns `[]` on backends that don't support it.
   */
  delayedAt = async (timestamp: number): Promise<any> => {
    return (await api.tasks.backend.delayedAt?.(timestamp)) ?? [];
  };

  /**
   * Return all delayed jobs, organized by the timestamp at where they are to run at.
   * Note: This is a very slow command.
   * Will throw an error if the backend cannot be reached.
   * @remarks node-resque-specific; returns `{}` on backends that don't support it.
   */
  allDelayed = async (): Promise<{ [timestamp: string]: any[] }> => {
    return (await api.tasks.backend.allDelayed?.()) ?? {};
  };

  /**
   * Return all workers registered by all members of this cluster.
   * Note: MultiWorker processors each register as a unique worker.
   * Will throw an error if the backend cannot be reached.
   */
  workers = async () => {
    return api.tasks.backend.getWorkers();
  };

  /**
   * What is a given worker working on?  If the worker is idle, 'started' will be returned.
   * Will throw an error if the backend cannot be reached.
   * @remarks node-resque-specific; returns `undefined` on backends that don't support it.
   */
  workingOn = async (workerName: string, queues: string): Promise<any> => {
    return api.tasks.backend.workingOn?.(workerName, queues);
  };

  /**
   * Return all workers and what job they might be working on.
   * Will throw an error if the backend cannot be reached.
   */
  allWorkingOn = async () => {
    return api.tasks.backend.allWorkingOn();
  };

  /**
   * How many jobs are in the failed queue.
   * Will throw an error if the backend cannot be reached.
   */
  failedCount = async (): Promise<number> => {
    return api.tasks.backend.failedCount();
  };

  /**
   * Retrieve the details of failed jobs between start and stop (0-indexed).
   * Will throw an error if the backend cannot be reached.
   */
  failed = async (start: number, stop: number) => {
    return api.tasks.backend.failed(start, stop);
  };

  /**
   * Remove a specific job from the failed queue.
   * Will throw an error if the backend cannot be reached.
   */
  removeFailed = async (failedJob: FailedJob) => {
    return api.tasks.backend.removeFailed(failedJob);
  };

  /**
   * Remove a specific job from the failed queue, and retry it by placing it back into its original queue.
   * Will throw an error if the backend cannot be reached.
   */
  retryAndRemoveFailed = async (failedJob: FailedJob) => {
    return api.tasks.backend.retryAndRemoveFailed(failedJob);
  };

  /**
   * If a worker process crashes, it will leave its state in redis as "working".
   * You can remove workers from redis you know to be over, by specificizing an age which would make them too old to exist.
   * This method will remove the data created by a 'stuck' worker and move the payload to the error queue.
   * However, it will not actually remove any processes which may be running.  A job *may* be running that you have removed.
   * Will throw an error if the backend cannot be reached.
   * @remarks node-resque-specific; returns `undefined` on backends that don't support it.
   */
  cleanOldWorkers = async (age: number) => {
    return api.tasks.backend.cleanOldWorkers?.(age);
  };

  /**
   * Ensures that an action which has a frequency is either running, or already enqueued.
   * Will throw an error if redis cannot be reached.
   */
  enqueueRecurrent = async (action: Action) => {
    if (action.task && action.task.frequency && action.task.frequency > 0) {
      await api[namespace].del(action.task.queue, action.name);
      await api[namespace].delDelayed(action.task.queue, action.name);
      await api[namespace].enqueueIn(
        action.task.frequency,
        action.name,
        {},
        undefined,
        true,
      );
      logger.debug(`enqueued recurrent job ${action.name}`);
    }
  };

  /**
   * This is run automatically at boot for all actions which have a frequency, calling `enqueueRecurrentTask`
   * Will throw an error if redis cannot be reached.
   */
  enqueueAllRecurrent = async () => {
    const enqueuedTasks: string[] = [];
    for (const action of api.actions.actions) {
      if (action.task && action.task.frequency && action.task.frequency > 0) {
        try {
          const toRun = await api[namespace].enqueue(action.name, {});
          if (toRun === true) {
            logger.info(`enqueued recurrent job ${action.name}`);
            enqueuedTasks.push(action.name);
          }
        } catch (error) {
          api[namespace].checkForRepeatRecurringTaskEnqueue(action.name, error);
        }
      }
    }

    return enqueuedTasks;
  };

  /**
   * Stop a task with a frequency by removing it from all possible queues (regular or delayed).
   * Will throw an error if redis cannot be reached.
   */
  stopRecurrentAction = async (actionName: string): Promise<number> => {
    const action = api.actions.actions.find(
      (a: Action) => a.name === actionName,
    );
    if (!action) {
      throw new TypedError({
        message: `action ${actionName} not found`,
        type: ErrorType.CONNECTION_TASK_DEFINITION,
      });
    }
    if (action.task && action.task.frequency && action.task.frequency > 0) {
      let removedCount = 0;
      const count = await api[namespace].del(
        action.task.queue ?? DEFAULT_QUEUE,
        action.name,
        undefined,
        1,
      );
      removedCount = removedCount + count;
      const timestamps = await api[namespace].delDelayed(
        action.task.queue ?? DEFAULT_QUEUE,
        action.name,
      );
      removedCount = removedCount + timestamps.length;
      return removedCount;
    }
    return 0;
  };

  /**
   * Return wholistic details about the task system, including failures, queues, and workers.
   * Will throw an error if redis cannot be reached.
   */
  taskDetails = async () => {
    const details: {
      queues: { [key: string]: any };
      workers: { [key: string]: any };
      stats: { [key: string]: any };
      leader: string;
    } = { queues: {}, workers: {}, stats: {}, leader: "" };

    details.workers = await api[namespace].allWorkingOn();
    details.stats = await api[namespace].resqueStats();
    const queues = await api.tasks.backend.queues();

    for (const i in queues) {
      const queue = queues[i];
      const length = await api.tasks.backend.queueLength(queue);
      details.queues[queue] = { length: length };
    }

    details.leader = await api.tasks.backend.leader();

    return details;
  };

  /**
   * Swallow "already enqueued" errors for recurring tasks (expected during multi-process boot).
   * Re-throws any other error.
   */
  checkForRepeatRecurringTaskEnqueue = (actionName: string, error: any) => {
    if (error.toString().match(/already enqueued at this time/)) {
      // this is OK, the job was enqueued by another process as this method was running
      logger.warn(
        `not enqueuing periodic task ${actionName} - error.toString()`,
      );
    } else {
      throw error;
    }
  };

  async initialize() {
    // Load plugin actions
    const pluginActions: Action[] = [];
    for (const plugin of config.plugins) {
      if (plugin.actions) {
        for (const ActionClass of plugin.actions) {
          pluginActions.push(new ActionClass());
        }
      }
    }

    // Load user actions
    const userActions = await globLoader<Action>(
      path.join(api.rootDir, "actions"),
    );

    const actions = [...pluginActions, ...userActions];

    for (const a of actions) {
      if (!a.description) a.description = `An Action: ${a.name}`;
      // MCP tools are opt-in: an action is exposed as a tool only when it
      // explicitly sets `mcp.tool = true` (or declares an MCP App via `mcp.ui`).
      // Defaulting to `false` prevents actions — especially destructive or
      // maintenance ones — from being silently reachable by any authenticated
      // MCP client just because they exist.
      a.mcp = { tool: false, ...a.mcp };
    }

    logger.info(
      formatLoadedMessage("actions", {
        plugin: pluginActions.length,
        user: userActions.length,
      }),
    );

    // Keep the router compile co-located with action assembly — if in-process
    // hot-reload is ever added, this is the single seam that must re-fire.
    // The getter lets the router track wholesale array replacement (e.g. tests
    // that do `api.actions.actions = api.actions.actions.filter(...)`).
    const router = new Router();
    router.compile(() => api.actions.actions);

    return {
      actions,
      router,

      enqueue: this.enqueue,
      fanOut: this.fanOut,
      fanOutStatus: this.fanOutStatus,
      enqueueAt: this.enqueueAt,
      enqueueIn: this.enqueueIn,
      del: this.del,
      delDelayed: this.delDelayed,
      delByFunction: this.delByFunction,
      scheduledAt: this.scheduledAt,
      resqueStats: this.resqueStats,
      queued: this.queued,
      delQueue: this.delQueue,
      locks: this.locks,
      delLock: this.delLock,
      timestamps: this.timestamps,
      delayedAt: this.delayedAt,
      allDelayed: this.allDelayed,
      workers: this.workers,
      workingOn: this.workingOn,
      allWorkingOn: this.allWorkingOn,
      failed: this.failed,
      failedCount: this.failedCount,
      removeFailed: this.removeFailed,
      retryAndRemoveFailed: this.retryAndRemoveFailed,
      cleanOldWorkers: this.cleanOldWorkers,
      enqueueRecurrent: this.enqueueRecurrent,
      enqueueAllRecurrent: this.enqueueAllRecurrent,
      stopRecurrentAction: this.stopRecurrentAction,
      taskDetails: this.taskDetails,
      checkForRepeatRecurringTaskEnqueue:
        this.checkForRepeatRecurringTaskEnqueue,
    };
  }
}
