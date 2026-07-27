import { loadFromEnvIfSet } from "../util/config";

export const configTasks = {
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

  // Options for the pg-boss (Postgres) task backend.
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
    // Max retries before a job is marked failed (0 = a single attempt, no retries).
    retryLimit: await loadFromEnvIfSet("TASKS_PGBOSS_RETRY_LIMIT", 0),
  },
};
