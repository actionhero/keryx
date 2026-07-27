import type { Action } from "./Action";
import type { RUN_MODE } from "./API";

/** Inputs passed to an enqueued task. Alias kept broad so any JSON-serializable payload fits. */
export type TaskInputs = Record<string, any>;

/**
 * A job as returned by {@link TaskBackend.queued}. A backend-neutral shape so `api.actions.queued()`
 * behaves identically regardless of which backend stores the job.
 */
export interface QueuedJob {
  /** The action name. */
  class: string;
  /** The queue the job is stored on. */
  queue: string;
  /** The job arguments, wrapped in a single-element array. */
  args: TaskInputs[];
}

/**
 * A backend-neutral failed job synthesized by the backend. `id` carries a backend-specific handle
 * (e.g. the pg-boss job id) for round-tripping through {@link TaskBackend.removeFailed} /
 * {@link TaskBackend.retryAndRemoveFailed}.
 */
export interface FailedJob {
  /** Backend-specific job id, when the backend keys failures by id (e.g. pg-boss). */
  id?: string;
  /** The queue the job failed on. */
  queue: string;
  /** The job payload — action name (`class`), queue, and args. */
  payload: { class?: string; queue?: string; args?: TaskInputs[] };
  /** The exception class/name, when available. */
  exception?: string;
  /** The error message. */
  error: string;
  /** The stack trace lines, when available. */
  backtrace?: string[] | null;
  /** The worker that was processing the job when it failed. */
  worker?: string;
  /** ISO timestamp of when the job failed. */
  failed_at?: string;
}

/**
 * Executes an action as a background task. Provided by the `tasks` initializer to each backend
 * so the shared lifecycle (fresh task-typed Connection, before/after job hooks, recurring
 * re-enqueue, fan-out result/error collection) lives in exactly one place. Resolves with the
 * action's response on success; **throws** on failure so the backend can mark the job failed
 * and apply its own retry semantics.
 *
 * @param actionName - Name of the action to run.
 * @param inputs - The decoded job inputs (already run through `onEnqueue` hooks at enqueue time).
 * @param ctx - Runtime context, notably the queue the job was pulled from (used to label metrics).
 */
export type TaskRunner = (
  actionName: string,
  inputs: TaskInputs,
  ctx: { queue: string },
) => Promise<unknown>;

/**
 * The pluggable queue seam. A concrete adapter ({@link PgBossBackend} is the one that ships)
 * implements this to store, schedule, and work background tasks while keeping the public
 * `api.actions.*` task interface unchanged. The `tasks` initializer instantiates the adapter at
 * boot and exposes it as `api.tasks.backend`.
 *
 * Methods fall into three groups: **lifecycle** (`start`/`stop` and the worker/scheduler
 * controls), **enqueue** (`enqueue`/`enqueueAt`/`enqueueIn`), and **introspection/management**
 * (everything else, surfaced through `api.actions.*`).
 */
export abstract class TaskBackend {
  /**
   * Bring the backend online. `mode` is the process run mode — SERVER processes work jobs
   * (workers + scheduler), CLI processes only enqueue. Adapters connect their client here.
   */
  abstract start(mode: RUN_MODE): Promise<void>;
  /** Tear the backend down: stop workers/scheduler (SERVER) and disconnect the client. */
  abstract stop(mode: RUN_MODE): Promise<void>;

  /** Start the worker pool so enqueued jobs begin processing. Idempotent-ish; safe to call once started stopped. */
  abstract startWorkers(): Promise<void>;
  /** Gracefully stop the worker pool, draining in-flight jobs. */
  abstract stopWorkers(): Promise<void>;
  /** Start the scheduler (delayed-job promotion, recurring boot enqueue). No-op on self-scheduling backends. */
  abstract startScheduler(): Promise<void>;
  /** Stop the scheduler. */
  abstract stopScheduler(): Promise<void>;

  /**
   * Register (or refresh) the backend-side wiring for an action. Called once per action at boot
   * and again when actions are added at runtime (e.g. in tests). Backends that dispatch
   * dynamically (like pg-boss, by action name) may treat this as a no-op.
   */
  abstract registerAction(action: Action): void;
  /** Remove an action's backend-side wiring (used when actions are torn down in tests). */
  abstract unregisterAction(actionName: string): void;

  /** Enqueue an action to run as soon as a worker is free. Resolves `true` when enqueued. */
  abstract enqueue(
    queue: string,
    actionName: string,
    inputs: TaskInputs,
  ): Promise<boolean>;
  /** Enqueue an action to become eligible at the given epoch-ms timestamp. */
  abstract enqueueAt(
    timestamp: number,
    queue: string,
    actionName: string,
    inputs: TaskInputs,
    suppressDuplicateTaskError?: boolean,
  ): Promise<boolean>;
  /** Enqueue an action to become eligible after a delay, in ms from now. */
  abstract enqueueIn(
    milliseconds: number,
    queue: string,
    actionName: string,
    inputs: TaskInputs,
    suppressDuplicateTaskError?: boolean,
  ): Promise<boolean>;

  /** Peek at jobs waiting on a queue (0-indexed range), normalized to {@link QueuedJob}. */
  abstract queued(
    queue: string,
    start: number,
    stop: number,
  ): Promise<QueuedJob[]>;
  /** Delete up to `count` matching not-yet-run jobs from a queue. Returns how many were removed. */
  abstract del(
    queue: string,
    actionName: string,
    inputs?: TaskInputs,
    count?: number,
  ): Promise<number>;
  /** Delete all delayed instances of a task. Returns the timestamps that were cleared. */
  abstract delDelayed(
    queue: string,
    actionName: string,
    inputs?: TaskInputs,
  ): Promise<number[]>;
  /** Return the future epoch-second timestamps at which a task is scheduled. */
  abstract scheduledAt(
    queue: string,
    actionName: string,
    inputs: TaskInputs,
  ): Promise<number[]>;

  /** Backend-wide stats (successes, failures, etc.). Shape is backend-specific. */
  abstract stats(): Promise<Record<string, any>>;
  /** All known queue names. */
  abstract queues(): Promise<string[]>;
  /** Number of jobs waiting on a queue. */
  abstract queueLength(queue: string): Promise<number>;
  /** Registered workers across the cluster, keyed by worker name. */
  abstract getWorkers(): Promise<Record<string, any>>;
  /** What every worker is currently working on, keyed by worker name. */
  abstract allWorkingOn(): Promise<Record<string, any>>;
  /** The current leader/coordinator identity, or `""` if the backend has no leader concept. */
  abstract leader(): Promise<string>;

  /** How many jobs are in the failed set. */
  abstract failedCount(): Promise<number>;
  /** Failed jobs in the 0-indexed range `[start, stop]`. */
  abstract failed(start: number, stop: number): Promise<FailedJob[]>;
  /** Permanently remove a failed job without retrying it. */
  abstract removeFailed(failedJob: FailedJob): Promise<void>;
  /** Remove a failed job and re-enqueue it onto its original queue. */
  abstract retryAndRemoveFailed(failedJob: FailedJob): Promise<void>;
}
