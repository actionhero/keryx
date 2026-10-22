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
  // how long before we mark a resque worker / task processor as stuck/dead?
  stuckWorkerTimeout: 1000 * 60 * 60,
  // how long (ms) a recurring task's run lock lasts without renewal. A running job renews it
  // every third of this; if the worker dies mid-run, the task resumes once the lock lapses.
  recurringLockTimeout: await loadFromEnvIfSet(
    "TASK_RECURRING_LOCK_TIMEOUT",
    15_000,
  ),
  // should the scheduler automatically try to retry failed tasks which were failed due to being 'stuck'?
  retryStuckJobs: false,
};
