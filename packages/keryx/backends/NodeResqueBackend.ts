import {
  type ErrorPayload,
  type Job,
  type ParsedJob,
  Queue,
  Scheduler,
  Worker,
} from "node-resque";
import { type Action, api, config, logger, RUN_MODE } from "../api";
import { LogFormat } from "../classes/Logger";
import {
  type FailedJob,
  type QueuedJob,
  TaskBackend,
  type TaskInputs,
  type TaskRunner,
} from "../classes/TaskBackend";

function logResqueEvent(
  level: "info" | "warn",
  textMessage: string,
  data: Record<string, any>,
) {
  if (config.logger.format === LogFormat.json) {
    logger[level](`resque ${data.event}`, data);
  } else {
    logger[level](textMessage);
  }
}

/**
 * The default, Redis-backed {@link TaskBackend}, wrapping [node-resque](https://github.com/actionhero/node-resque).
 * Manages the resque `Queue`, `Scheduler`, and worker pool, and registers every action as a resque
 * job whose `perform` delegates to the shared {@link TaskRunner}.
 *
 * In addition to the abstract `TaskBackend` surface this exposes node-resque internals
 * (`queue`, `scheduler`, `workers`, `jobs`, `wrapActionAsJob`, and the start/stop controls),
 * which back the deprecated `api.resque` alias and the `resque-admin` plugin.
 */
export class NodeResqueBackend extends TaskBackend {
  /** The node-resque `Queue` used to enqueue and introspect jobs. */
  queue!: Queue;
  /** The node-resque `Scheduler` (leader election, delayed-job promotion, stuck-worker cleanup). */
  scheduler!: Scheduler;
  /** The pool of node-resque `Worker` instances. */
  workers: Worker[] = [];
  /** The map of action name → node-resque job definition. Workers read this by reference. */
  jobs: Record<string, Job<any>> = {};

  private taskRunner: TaskRunner;

  /**
   * @param taskRunner - The shared executor (built by the `tasks` initializer) that runs an
   *   action inside a fresh task connection, fires job hooks, records fan-out results, and
   *   re-enqueues recurring tasks. Each job's `perform` calls it.
   */
  constructor(taskRunner: TaskRunner) {
    super();
    this.taskRunner = taskRunner;
    this.loadJobs();
  }

  async start(mode: RUN_MODE) {
    await this.startQueue();

    if (mode === RUN_MODE.SERVER) {
      await this.startScheduler();
      await this.startWorkers();
    }
  }

  async stop(mode: RUN_MODE) {
    if (mode === RUN_MODE.SERVER) {
      await this.stopWorkers();
      await this.stopScheduler();
    }

    await this.stopQueue();
  }

  /** Create and connect the resque `Queue` instance (used for enqueuing jobs). */
  startQueue = async () => {
    this.queue = new Queue(
      { connection: { redis: api.redis.redis } },
      this.jobs,
    );

    this.queue.on("error", (error: Error) => {
      logger.error(`[resque:queue] ${error}`);
    });

    await this.queue.connect();
  };

  /** Disconnect the resque `Queue`. */
  stopQueue = async () => {
    if (this.queue) {
      return this.queue.end();
    }
  };

  /** Create and start the resque `Scheduler` (leader election, delayed job promotion, stuck worker cleanup). */
  startScheduler = async () => {
    if (config.tasks.enabled === true) {
      this.scheduler = new Scheduler({
        connection: { redis: api.redis.redis },
        timeout: config.tasks.timeout,
        stuckWorkerTimeout: config.tasks.nodeResque.stuckWorkerTimeout,
        retryStuckJobs: config.tasks.nodeResque.retryStuckJobs,
      });

      this.scheduler.on("error", (error: Error) => {
        logger.error(`[resque:scheduler] ${error}`);
      });

      await this.scheduler.connect();

      this.scheduler.on("start", () => {
        logger.info(`[resque:scheduler] started`);
      });
      this.scheduler.on("end", () => {
        logger.info(`[resque:scheduler] ended`);
      });
      this.scheduler.on("poll", () => {
        logger.debug(`[resque:scheduler] polling`);
      });
      this.scheduler.on("leader", () => {
        logger.info(`[resque:scheduler] leader elected`);
      });
      this.scheduler.on(
        "cleanStuckWorker",
        (workerName: string, errorPayload: ErrorPayload, delta: number) => {
          logger.warn(
            `[resque:scheduler] cleaning stuck worker: ${workerName}, ${errorPayload}, ${delta}`,
          );
        },
      );

      this.scheduler.start();
      await api.actions.enqueueAllRecurrent();
    }
  };

  /** Stop the resque `Scheduler` and disconnect. */
  stopScheduler = async () => {
    if (this.scheduler && this.scheduler.connection.connected) {
      await this.scheduler.end();
    }
  };

  /** Spin up `config.tasks.taskProcessors` worker instances and connect them to Redis. */
  startWorkers = async () => {
    let id = 0;

    while (id < config.tasks.taskProcessors) {
      const worker = new Worker(
        {
          connection: { redis: api.redis.redis },
          queues: Array.isArray(config.tasks.queues)
            ? config.tasks.queues
            : await config.tasks.queues(),
          timeout: config.tasks.timeout,
          name: `worker:${id}`,
        },
        this.jobs,
      );

      // normal worker emitters
      worker.on("start", () => {
        logger.info(`[resque:${worker.name}] started`);
      });
      worker.on("end", () => {
        logger.info(`[resque:${worker.name}] ended`);
      });
      worker.on("cleaning_worker", (workerName, pid) => {
        logger.debug(
          `[resque:${worker.name}] cleaning worker, ${workerName}, ${pid}`,
        );
      });
      worker.on("poll", (queue) => {
        logger.debug(`[resque:${worker.name}] polling, ${queue}`);
      });
      worker.on("job", (queue, job: ParsedJob) => {
        logger.debug(
          `[resque:${worker.name}] job acquired, ${queue}, ${job.class}, ${JSON.stringify(job.args[0])}`,
        );
      });
      worker.on("reEnqueue", (queue, job: ParsedJob, _plugin) => {
        logger.debug(
          `[resque:${worker.name}] job reEnqueue, ${queue}, ${job.class}, ${JSON.stringify(job.args[0])}`,
        );
      });
      worker.on("pause", () => {
        logger.debug(`[resque:${worker.name}] paused`);
      });

      worker.on("failure", (queue, job, failure, duration) => {
        logResqueEvent(
          "warn",
          `[resque:${worker.name}] job failed, ${queue}, ${job.class}, ${JSON.stringify(job?.args[0] ?? {})}: ${failure} (${duration}ms)`,
          {
            worker: worker.name,
            event: "failure",
            queue,
            jobClass: job?.class,
            args: job?.args[0] ?? {},
            error: String(failure),
            duration,
          },
        );
      });
      worker.on("error", (error, queue, job) => {
        logResqueEvent(
          "warn",
          `[resque:${worker.name}] job error, ${queue}, ${job?.class}, ${JSON.stringify(job?.args[0] ?? {})}: ${error}`,
          {
            worker: worker.name,
            event: "error",
            queue,
            jobClass: job?.class,
            args: job?.args[0] ?? {},
            error: String(error),
          },
        );
      });

      worker.on("success", (queue, job: ParsedJob, result, duration) => {
        logResqueEvent(
          "info",
          `[resque:${worker.name}] job success ${queue}, ${job.class}, ${JSON.stringify(job.args[0])} | ${JSON.stringify(result)} (${duration}ms)`,
          {
            worker: worker.name,
            event: "success",
            queue,
            jobClass: job.class,
            args: job.args[0],
            result,
            duration,
          },
        );
      });

      this.workers.push(worker);
      id++;
    }

    for (const worker of this.workers) {
      try {
        await worker.connect();
        await worker.start();
      } catch (error) {
        logger.fatal(`[resque:${worker.name}] ${error}`);
        throw error;
      }
    }
  };

  /** Gracefully stop all workers: signal them to stop polling, drain in-flight operations, then disconnect. */
  stopWorkers = async () => {
    // Signal all workers to stop polling/pinging before closing connections.
    // worker.end() clears timers and closes the Redis connection, but if a
    // poll() or ping() callback already fired and has an in-flight Redis
    // command, it will reject with "Connection is closed." Setting running=false
    // first ensures no NEW operations start, then we drain any in-flight ones.
    for (const worker of this.workers) {
      worker.running = false;
    }
    await Bun.sleep(250);

    while (true) {
      const worker = this.workers.pop();
      if (!worker) break;
      await worker.end();
    }
    this.workers = [];
  };

  /** Build the node-resque job map for all currently-registered actions. */
  loadJobs = () => {
    for (const action of api.actions.actions) {
      this.jobs[action.name] = this.wrapActionAsJob(action);
    }
  };

  registerAction = (action: Action) => {
    this.jobs[action.name] = this.wrapActionAsJob(action);
  };

  unregisterAction = (actionName: string) => {
    delete this.jobs[actionName];
  };

  /**
   * Wrap an action as a node-resque job. The `perform` callback extracts the plain params and the
   * queue the job was pulled from, then hands off to the shared {@link TaskRunner}, which owns the
   * connection lifecycle, job hooks, fan-out recording, and recurring re-enqueue. Recurring actions
   * additionally get JobLock/QueueLock/DelayQueueLock plugins so only one copy is ever enqueued.
   */
  wrapActionAsJob = (
    action: Action,
  ): Job<Awaited<ReturnType<(typeof action)["run"]>>> => {
    const taskRunner = this.taskRunner;
    const job: Job<any> = {
      plugins: [],
      pluginOptions: {},

      perform: async function (params: TaskInputs) {
        const plainParams: Record<string, unknown> =
          typeof params === "object" && params !== null
            ? Object.fromEntries(
                typeof params.entries === "function"
                  ? params.entries()
                  : Object.entries(params),
              )
            : {};

        // node-resque invokes `perform` via `.apply(worker, args)`, so `this`
        // is the Worker and `Worker.queue` is the queue the current job was
        // pulled from. TypeScript infers `this` as the Job here because
        // `perform` lives inside the Job literal, so cast through `unknown` to
        // read the runtime binding.
        const runtimeThis = this as unknown as { queue?: unknown };
        const currentQueue =
          typeof runtimeThis?.queue === "string" ? runtimeThis.queue : "";

        return taskRunner(action.name, plainParams, { queue: currentQueue });
      },
    };

    if (action.task && action.task.frequency && action.task.frequency > 0) {
      job.plugins!.push("JobLock");
      job.pluginOptions!.JobLock = { reEnqueue: false };
      job.plugins!.push("QueueLock");
      job.plugins!.push("DelayQueueLock");
    }

    return job;
  };

  // --- Enqueue (node-resque wraps inputs in a single-element args array) ---

  enqueue = (queue: string, actionName: string, inputs: TaskInputs) =>
    this.queue.enqueue(queue, actionName, [inputs]);

  enqueueAt = (
    timestamp: number,
    queue: string,
    actionName: string,
    inputs: TaskInputs,
    suppressDuplicateTaskError = false,
  ) =>
    this.queue.enqueueAt(
      timestamp,
      queue,
      actionName,
      [inputs],
      suppressDuplicateTaskError,
    );

  enqueueIn = (
    milliseconds: number,
    queue: string,
    actionName: string,
    inputs: TaskInputs,
    suppressDuplicateTaskError = false,
  ) =>
    this.queue.enqueueIn(
      milliseconds,
      queue,
      actionName,
      [inputs],
      suppressDuplicateTaskError,
    );

  // --- Introspection / management ---

  queued = (queue: string, start: number, stop: number) =>
    this.queue.queued(queue, start, stop) as Promise<QueuedJob[]>;

  del = (
    queue: string,
    actionName: string,
    inputs?: TaskInputs,
    count?: number,
  ) => this.queue.del(queue, actionName, [inputs], count);

  delDelayed = (queue: string, actionName: string, inputs?: TaskInputs) =>
    this.queue.delDelayed(queue, actionName, [inputs]);

  scheduledAt = (queue: string, actionName: string, inputs: TaskInputs) =>
    this.queue.scheduledAt(queue, actionName, [inputs]);

  stats = () => this.queue.stats();

  queues = () => this.queue.queues();

  queueLength = (queue: string) => this.queue.length(queue);

  getWorkers = () => this.queue.workers();

  allWorkingOn = () => this.queue.allWorkingOn();

  leader = async () => (await this.queue.leader()) ?? "";

  failedCount = () => this.queue.failedCount();

  failed = (start: number, stop: number) =>
    this.queue.failed(start, stop) as Promise<FailedJob[]>;

  removeFailed = async (failedJob: FailedJob) => {
    await this.queue.removeFailed(failedJob as unknown as ErrorPayload);
  };

  retryAndRemoveFailed = async (failedJob: FailedJob) => {
    await this.queue.retryAndRemoveFailed(failedJob as unknown as ErrorPayload);
  };

  // --- node-resque-specific extras (optional on the abstract interface) ---

  delByFunction = (
    queue: string,
    actionName: string,
    start?: number,
    stop?: number,
  ) => this.queue.delByFunction(queue, actionName, start, stop);

  delQueue = (queue: string) => this.queue.delQueue(queue);

  locks = () => this.queue.locks();

  delLock = (lock: string) => this.queue.delLock(lock);

  timestamps = () => this.queue.timestamps();

  delayedAt = (timestamp: number) => this.queue.delayedAt(timestamp);

  allDelayed = () => this.queue.allDelayed();

  workingOn = (workerName: string, queues: string) =>
    this.queue.workingOn(workerName, queues);

  cleanOldWorkers = (age: number) => this.queue.cleanOldWorkers(age);
}
