import {
  type ErrorPayload,
  type Job,
  type ParsedJob,
  Queue,
  Scheduler,
  Worker,
} from "node-resque";
import {
  Action,
  type ActionParams,
  api,
  Connection,
  config,
  logger,
  RUN_MODE,
} from "../api";
import { Initializer } from "../classes/Initializer";
import { LogFormat } from "../classes/Logger";
import { TypedError } from "../classes/TypedError";

const namespace = "resque";

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

declare module "../classes/API" {
  export interface API {
    [namespace]: Awaited<ReturnType<Resque["initialize"]>>;
  }
}

let SERVER_JOB_COUNTER = 1;

/**
 * Initializer for the node-resque background job system. Manages the queue, scheduler,
 * and worker pool. All actions are automatically registered as resque jobs.
 * Exposes `api.resque.queue`, `api.resque.scheduler`, and `api.resque.workers`.
 */
export class Resque extends Initializer {
  constructor() {
    super(namespace);

    this.loadPriority = 250;
    this.startPriority = 10000;
    this.stopPriority = 900;
  }

  /** Create and connect the resque `Queue` instance (used for enqueuing jobs). */
  startQueue = async () => {
    api.resque.queue = new Queue(
      { connection: { redis: api.redis.redis } },
      api.resque.jobs,
    );

    api.resque.queue.on("error", (error: Error) => {
      logger.error(`[resque:queue] ${error}`);
    });

    await api.resque.queue.connect();
  };

  /** Disconnect the resque `Queue`. */
  stopQueue = async () => {
    if (api.resque.queue) {
      return api.resque.queue.end();
    }
  };

  /** Create and start the resque `Scheduler` (leader election, delayed job promotion, stuck worker cleanup). */
  startScheduler = async () => {
    if (config.tasks.enabled === true) {
      api.resque.scheduler = new Scheduler({
        connection: { redis: api.redis.redis },
        timeout: config.tasks.timeout,
        stuckWorkerTimeout: config.tasks.stuckWorkerTimeout,
        retryStuckJobs: config.tasks.retryStuckJobs,
      });

      api.resque.scheduler.on("error", (error: Error) => {
        logger.error(`[resque:scheduler] ${error}`);
      });

      await api.resque.scheduler.connect();

      api.resque.scheduler.on("start", () => {
        logger.info(`[resque:scheduler] started`);
      });
      api.resque.scheduler.on("end", () => {
        logger.info(`[resque:scheduler] ended`);
      });
      api.resque.scheduler.on("poll", () => {
        logger.debug(`[resque:scheduler] polling`);
      });
      api.resque.scheduler.on("leader", () => {
        logger.info(`[resque:scheduler] leader elected`);
      });
      api.resque.scheduler.on(
        "cleanStuckWorker",
        (workerName: string, errorPayload: ErrorPayload, delta: number) => {
          logger.warn(
            `[resque:scheduler] cleaning stuck worker: ${workerName}, ${errorPayload}, ${delta}`,
          );
        },
      );

      api.resque.scheduler.start();
      await api.actions.enqueueAllRecurrent();
    }
  };

  /** Stop the resque `Scheduler` and disconnect. */
  stopScheduler = async () => {
    if (api.resque.scheduler && api.resque.scheduler.connection.connected) {
      await api.resque.scheduler.end();
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
        api.resque.jobs,
      );

      // normal worker emitters
      worker.on("start", () => {
        logger.info(`[resque:${worker.name}] started`);
      });
      worker.on("end", () => {
        logger.info(`[resque:${worker.name}] ended`);
      });
      worker.on("cleaning_worker", () => {
        logger.debug(`[resque:${worker.name}] cleaning worker`);
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
        api.observability.task.executedTotal.add(1, {
          action: job.class,
          queue,
          status: "failure",
        });
        api.observability.task.duration.record(duration, {
          action: job.class,
        });
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
        api.observability.task.executedTotal.add(1, {
          action: job.class,
          queue,
          status: "success",
        });
        api.observability.task.duration.record(duration, {
          action: job.class,
        });
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

      api.resque.workers.push(worker);
      id++;
    }

    for (const worker of api.resque.workers) {
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
    for (const worker of api.resque.workers) {
      worker.running = false;
    }
    await Bun.sleep(250);

    while (true) {
      const worker = api.resque.workers.pop();
      if (!worker) break;
      await worker.end();
    }
    api.resque.workers = [];
  };

  /** Load all actions as tasks and wrap them for node-resque jobs */
  loadJobs = async () => {
    const jobs: Record<string, Job<any>> = {};

    for (const action of api.actions.actions) {
      const job = this.wrapActionAsJob(action);
      jobs[action.name] = job;
    }

    return jobs;
  };

  /**
   * Wrap an action as a node-resque job. Creates a fresh `Connection` of type `"task"`
   * with an empty in-memory session stub (tasks are fresh starts — no Redis read/write
   * for session), converts inputs to a plain object, and runs the action via
   * `connection.act()`. Handles fan-out result/error collection and recurring task
   * re-enqueue.
   */
  wrapActionAsJob = (
    action: Action,
  ): Job<Awaited<ReturnType<(typeof action)["run"]>>> => {
    const job: Job<ReturnType<Action["run"]>> = {
      plugins: [],
      pluginOptions: {},

      perform: async function (params: ActionParams<typeof action>) {
        const plainParams: Record<string, unknown> =
          typeof params === "object" && params !== null
            ? Object.fromEntries(
                typeof params.entries === "function"
                  ? params.entries()
                  : Object.entries(params),
              )
            : {};

        const propagatedCorrelationId = plainParams._correlationId as
          | string
          | undefined;

        const connection = new Connection(
          "task",
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

        const fanOutId = plainParams._fanOutId as string | undefined;

        let response: Awaited<ReturnType<(typeof action)["run"]>>;
        let error: TypedError | undefined;
        try {
          const payload = await connection.act(action.name, plainParams);
          response = payload.response;
          error = payload.error;

          if (error) throw error;
        } catch (e) {
          // Collect fan-out error before re-throwing
          if (fanOutId) {
            const metaKey = `fanout:${fanOutId}`;
            const errorsKey = `fanout:${fanOutId}:errors`;
            const errorMessage = e instanceof Error ? e.message : String(e);
            await api.redis.redis.rpush(
              errorsKey,
              JSON.stringify({ params, error: errorMessage }),
            );
            await api.redis.redis.hincrby(metaKey, "failed", 1);
            // Refresh TTL on all fan-out keys
            const ttl = await api.redis.redis.ttl(metaKey);
            if (ttl > 0) {
              await api.redis.redis.expire(metaKey, ttl);
              await api.redis.redis.expire(`fanout:${fanOutId}:results`, ttl);
              await api.redis.redis.expire(errorsKey, ttl);
            }
          }
          throw e;
        } finally {
          if (
            action.task &&
            action.task.frequency &&
            action.task.frequency > 0
          ) {
            await api.actions.enqueueRecurrent(action);
          }
        }

        // Collect fan-out result on success
        if (fanOutId) {
          const metaKey = `fanout:${fanOutId}`;
          const resultsKey = `fanout:${fanOutId}:results`;
          await api.redis.redis.rpush(
            resultsKey,
            JSON.stringify({ params, result: response }),
          );
          await api.redis.redis.hincrby(metaKey, "completed", 1);
          // Refresh TTL on all fan-out keys
          const ttl = await api.redis.redis.ttl(metaKey);
          if (ttl > 0) {
            await api.redis.redis.expire(metaKey, ttl);
            await api.redis.redis.expire(resultsKey, ttl);
            await api.redis.redis.expire(`fanout:${fanOutId}:errors`, ttl);
          }
        }

        return response;
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

  async initialize() {
    const resqueContainer = {
      jobs: await this.loadJobs(),
      workers: [] as Worker[],
      startQueue: this.startQueue,
      stopQueue: this.stopQueue,
      startScheduler: this.startScheduler,
      stopScheduler: this.stopScheduler,
      startWorkers: this.startWorkers,
      stopWorkers: this.stopWorkers,
      wrapActionAsJob: this.wrapActionAsJob,
    } as {
      queue: Queue;
      scheduler: Scheduler;
      workers: Worker[];
      jobs: Awaited<ReturnType<Resque["loadJobs"]>>;
      startQueue: () => Promise<void>;
      stopQueue: () => Promise<void>;
      startScheduler: () => Promise<void>;
      stopScheduler: () => Promise<void>;
      startWorkers: () => Promise<void>;
      stopWorkers: () => Promise<void>;
      wrapActionAsJob: (action: Action) => Job<any>;
    };

    return resqueContainer;
  }

  async start() {
    await this.startQueue();

    if (api.runMode === RUN_MODE.SERVER) {
      await this.startScheduler();
      await this.startWorkers();
    }
  }

  async stop() {
    if (api.runMode === RUN_MODE.SERVER) {
      await this.stopWorkers();
      await this.stopScheduler();
    }

    await this.stopQueue();
  }
}
