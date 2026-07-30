import type { FanOutStatus, TaskInputs } from "../initializers/actionts";

/**
 * The fan-out state seam. Decouples fan-out progress tracking + result collection from the storage
 * engine. {@link PgFanOutStore} is the implementation that ships; the `tasks` initializer
 * instantiates it and exposes it as `api.tasks.fanOutStore`.
 *
 * Lifecycle: `create()` is called once by `api.actions.fanOut()` when the batch is enqueued;
 * `recordResult()` / `recordError()` are called by the shared task runner as each child job
 * settles; `read()` backs `api.actions.fanOutStatus()`. All state expires after the TTL passed
 * to `create()`.
 */
export abstract class FanOutStore {
  /** Connect/prepare the store (e.g. create tables). Called during the `tasks` start phase. */
  abstract start(): Promise<void>;
  /** Release any store-owned resources. Called during the `tasks` stop phase. */
  abstract stop(): Promise<void>;

  /**
   * Initialize tracking for a new fan-out batch.
   *
   * @param fanOutId - Unique id for the batch (also injected into each child job as `_fanOutId`).
   * @param total - Number of child jobs enqueued.
   * @param actionNames - Distinct action names involved in the batch.
   * @param queues - Distinct queues the jobs were enqueued to.
   * @param ttlSeconds - How long the batch's state should live before expiring.
   */
  abstract create(
    fanOutId: string,
    total: number,
    actionNames: string[],
    queues: string[],
    ttlSeconds: number,
  ): Promise<void>;

  /**
   * Record a successful child-job result and increment the completed counter.
   *
   * @param fanOutId - The batch id from the child job's `_fanOutId`.
   * @param params - The child job's inputs (for correlating the result).
   * @param result - The child action's return value.
   */
  abstract recordResult(
    fanOutId: string,
    params: TaskInputs,
    result: unknown,
  ): Promise<void>;

  /**
   * Record a failed child-job error and increment the failed counter.
   *
   * @param fanOutId - The batch id from the child job's `_fanOutId`.
   * @param params - The child job's inputs (for correlating the error).
   * @param error - The error message.
   */
  abstract recordError(
    fanOutId: string,
    params: TaskInputs,
    error: string,
  ): Promise<void>;

  /**
   * Read the current status of a fan-out batch. Returns all-zero counts + empty arrays for an
   * unknown or expired `fanOutId`.
   */
  abstract read(fanOutId: string): Promise<FanOutStatus>;
}
