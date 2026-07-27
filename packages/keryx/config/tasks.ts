import { loadFromEnvIfSet } from "../util/config";

/** The queue backend that stores and works background tasks. */
export type TasksBackend = "node-resque" | "pg-boss";
/** The store that tracks fan-out progress and collects child-job results. */
export type TasksFanOutStore = "redis" | "postgres";

export const configTasks = {
  // Which queue backend to use. `node-resque` (default) stores jobs in Redis;
  // `pg-boss` stores them in Postgres so Redis can be dropped entirely.
  backend: (await loadFromEnvIfSet(
    "TASKS_BACKEND",
    "node-resque",
  )) as TasksBackend,
  // Where fan-out progress + results are tracked. `redis` (default) uses Redis
  // hashes/lists; `postgres` uses two framework-managed tables.
  fanOutStore: (await loadFromEnvIfSet(
    "TASKS_FANOUT_STORE",
    "redis",
  )) as TasksFanOutStore,
  enabled: await loadFromEnvIfSet("TASKS_ENABLED", true),
  // What queues should the taskProcessors work?
  // Order controls worker priority: workers drain queues left-to-right.
  // e.g. ["worker", "scheduler"] means "worker" jobs are processed before "scheduler" jobs.
  // Use ["*"] to process all queues with equal priority.
  queues: ["*"] as string[] | (() => Promise<string[]>),
  // Or, rather than providing a static list of `queues`, you can define a method that returns the list of queues.
  // queues: async () => { return ["queueA", "queueB"]; } as string[] | (() => Promise<string[]>)>,
  // how long to sleep between jobs / scheduler checks
  timeout: await loadFromEnvIfSet("TASK_TIMEOUT", 5000),
  // how many parallel workers we run?
  taskProcessors: await loadFromEnvIfSet(
    "TASK_PROCESSORS",
    Bun.env.NODE_ENV === "test" ? 0 : 1,
  ),
  // how often should we check the event loop to spawn more taskProcessors?
  checkTimeout: 500,
  // how many ms would constitute an event loop delay to halt taskProcessors spawning?
  maxEventLoopDelay: 5,

  // Options read only when `backend === "node-resque"`.
  nodeResque: {
    // how long before we mark a resque worker / task processor as stuck/dead?
    stuckWorkerTimeout: 1000 * 60 * 60,
    // should the scheduler automatically try to retry failed tasks which were failed due to being 'stuck'?
    retryStuckJobs: false,
  },

  // Options read only when `backend === "pg-boss"`.
  pgBoss: {
    // Postgres schema pg-boss creates and owns for its own tables.
    schema: (await loadFromEnvIfSet("TASKS_PGBOSS_SCHEMA", "keryx_tasks")) as
      | string
      | undefined,
    // How long to retain completed jobs before pg-boss deletes them, in seconds.
    deleteAfterSeconds: await loadFromEnvIfSet(
      "TASKS_PGBOSS_DELETE_AFTER_SECONDS",
      7 * 24 * 60 * 60,
    ),
    // Max retries before a job is marked failed (mirrors node-resque's single-attempt default of 0).
    retryLimit: await loadFromEnvIfSet("TASKS_PGBOSS_RETRY_LIMIT", 0),
  },
};
