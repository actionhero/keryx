import { randomUUID } from "crypto";
import type { ErrorPayload } from "node-resque";
import path from "path";
import { api, logger } from "../api";
import { type Action, DEFAULT_QUEUE } from "../classes/Action";
import { Initializer } from "../classes/Initializer";
import { Router } from "../classes/Router";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import { formatLoadedMessage } from "../util/config";
import { globLoader } from "../util/glob";

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

declare module "../classes/API" {
  export interface API {
    [namespace]: Awaited<ReturnType<Actions["initialize"]>>;
  }
}

export type TaskInputs = Record<string, any>;

export class Actions extends Initializer {
  constructor() {
    super(namespace);
  }

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
    api.observability.task.enqueuedTotal.add(1, {
      action: actionName,
      queue,
    });
    return api.resque.queue.enqueue(queue, actionName, [inputs]);
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
    const metaKey = `fanout:${fanOutId}`;

    // Collect unique queues used
    const queuesUsed = [...new Set(resolvedJobs.map((j) => j.queue))];
    const actionNamesList = [...actionNames];

    // Store fan-out metadata in Redis
    await api.redis.redis.hset(metaKey, {
      total: resolvedJobs.length.toString(),
      completed: "0",
      failed: "0",
      actionName: actionNamesList.join(","),
      queue: queuesUsed.join(","),
    });
    await api.redis.redis.expire(metaKey, resultTtl);

    // Pre-create results/errors lists with TTL so they exist for queries
    const resultsKey = `fanout:${fanOutId}:results`;
    const errorsKey = `fanout:${fanOutId}:errors`;
    await api.redis.redis.expire(resultsKey, resultTtl);
    await api.redis.redis.expire(errorsKey, resultTtl);

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
    const metaKey = `fanout:${fanOutId}`;
    const meta = await api.redis.redis.hgetall(metaKey);

    if (!meta || Object.keys(meta).length === 0) {
      return { total: 0, completed: 0, failed: 0, results: [], errors: [] };
    }

    const resultsKey = `fanout:${fanOutId}:results`;
    const errorsKey = `fanout:${fanOutId}:errors`;

    const [rawResults, rawErrors] = await Promise.all([
      api.redis.redis.lrange(resultsKey, 0, -1),
      api.redis.redis.lrange(errorsKey, 0, -1),
    ]);

    return {
      total: parseInt(meta.total, 10) || 0,
      completed: parseInt(meta.completed, 10) || 0,
      failed: parseInt(meta.failed, 10) || 0,
      results: rawResults.map((r: string) => JSON.parse(r)),
      errors: rawErrors.map((e: string) => JSON.parse(e)),
    };
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
    return api.resque.queue.enqueueAt(
      timestamp,
      queue,
      actionName,
      [inputs],
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
    return api.resque.queue.enqueueIn(
      time,
      queue,
      actionName,
      [inputs],
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
    return api.resque.queue.del(queue, actionName, [args], count);
  };

  /**
   * Delete all jobs of a given action name from a queue. Does not affect delayed queues,
   * and will not prevent new jobs from being added while running.
   *
   * @param queue - The queue to delete from.
   * @param actionName - The action name whose jobs to remove.
   * @param start - Starting position (0-indexed) of the range to remove.
   * @param stop - Stop position (0-indexed) of the range to remove.
   */
  delByFunction = async (
    queue: string,
    actionName: string,
    start?: number,
    stop?: number,
  ) => {
    return api.resque.queue.delByFunction(queue, actionName, start, stop);
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
    return api.resque.queue.delDelayed(queue, actionName, [inputs]);
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
    return api.resque.queue.scheduledAt(queue, actionName, [inputs]);
  };

  /**
   * Return all resque stats for this namespace (how jobs failed, jobs succeeded, etc)
   * Will throw an error if redis cannot be reached.
   */
  resqueStats = async () => {
    return api.resque.queue.stats();
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
    return api.resque.queue.queued(queue, start, stop);
  };

  /**
   * Delete a queue in redis, and all jobs stored on it.
   * Will throw an error if redis cannot be reached.
   */
  delQueue = async (q: string) => {
    return api.resque.queue.delQueue(q);
  };

  /**
   * Return any locks, as created by resque plugins or task middleware, in this redis namespace.
   * Will contain locks with keys like `resque:lock:{job}` and `resque:workerslock:{workerId}`
   * Will throw an error if redis cannot be reached.
   */
  locks = async () => {
    return api.resque.queue.locks();
  };

  /**
   * Delete a lock on a job or worker.  Locks can be found via `api.tasks.locks`
   * Will throw an error if redis cannot be reached.
   */
  delLock = async (lock: string) => {
    return api.resque.queue.delLock(lock);
  };

  /**
   * List all timestamps for which tasks are enqueued in the future, via `api.tasks.enqueueIn` or `api.tasks.enqueueAt`
   * Will throw an error if redis cannot be reached.
   */
  timestamps = async (): Promise<Array<number>> => {
    return api.resque.queue.timestamps();
  };

  /**
   * Return all jobs which have been enqueued to run at a certain timestamp.
   * Will throw an error if redis cannot be reached.
   */
  delayedAt = async (timestamp: number): Promise<any> => {
    return api.resque.queue.delayedAt(timestamp);
  };

  /**
   * Return all delayed jobs, organized by the timestamp at where they are to run at.
   * Note: This is a very slow command.
   * Will throw an error if redis cannot be reached.
   */
  allDelayed = async (): Promise<{ [timestamp: string]: any[] }> => {
    return api.resque.queue.allDelayed();
  };

  /**
   * Return all workers registered by all members of this cluster.
   * Note: MultiWorker processors each register as a unique worker.
   * Will throw an error if redis cannot be reached.
   */
  workers = async () => {
    return api.resque.queue.workers();
  };

  /**
   * What is a given worker working on?  If the worker is idle, 'started' will be returned.
   * Will throw an error if redis cannot be reached.
   */
  workingOn = async (workerName: string, queues: string): Promise<any> => {
    return api.resque.queue.workingOn(workerName, queues);
  };

  /**
   * Return all workers and what job they might be working on.
   * Will throw an error if redis cannot be reached.
   */
  allWorkingOn = async () => {
    return api.resque.queue.allWorkingOn();
  };

  /**
   * How many jobs are in the failed queue.
   * Will throw an error if redis cannot be reached.
   */
  failedCount = async (): Promise<number> => {
    return api.resque.queue.failedCount();
  };

  /**
   * Retrieve the details of failed jobs between start and stop (0-indexed).
   * Will throw an error if redis cannot be reached.
   */
  failed = async (start: number, stop: number) => {
    return api.resque.queue.failed(start, stop);
  };

  /**
   * Remove a specific job from the failed queue.
   * Will throw an error if redis cannot be reached.
   */
  removeFailed = async (failedJob: ErrorPayload) => {
    return api.resque.queue.removeFailed(failedJob);
  };

  /**
   * Remove a specific job from the failed queue, and retry it by placing it back into its original queue.
   * Will throw an error if redis cannot be reached.
   */
  retryAndRemoveFailed = async (failedJob: ErrorPayload) => {
    return api.resque.queue.retryAndRemoveFailed(failedJob);
  };

  /**
   * If a worker process crashes, it will leave its state in redis as "working".
   * You can remove workers from redis you know to be over, by specificizing an age which would make them too old to exist.
   * This method will remove the data created by a 'stuck' worker and move the payload to the error queue.
   * However, it will not actually remove any processes which may be running.  A job *may* be running that you have removed.
   * Will throw an error if redis cannot be reached.
   */
  cleanOldWorkers = async (age: number) => {
    return api.resque.queue.cleanOldWorkers(age);
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
    const queues = await api.resque.queue.queues();

    for (const i in queues) {
      const queue = queues[i];
      const length = await api.resque.queue.length(queue);
      details.queues[queue] = { length: length };
    }

    details.leader = await api.resque.queue.leader();

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
      a.mcp = { tool: true, ...a.mcp };
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
