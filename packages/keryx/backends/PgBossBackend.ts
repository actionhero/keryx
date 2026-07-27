import type { Job } from "pg-boss";
import { PgBoss } from "pg-boss";
import { type Action, api, config, logger, RUN_MODE } from "../api";
import { DEFAULT_QUEUE } from "../classes/Action";
import {
  type FailedJob,
  type QueuedJob,
  TaskBackend,
  type TaskInputs,
  type TaskRunner,
} from "../classes/TaskBackend";
import { ErrorType, TypedError } from "../classes/TypedError";

/**
 * A dedicated pg-boss queue for recurring (frequency-based) actions, created with the `short`
 * policy so its unique index (`job_i1`: `UNIQUE (name, COALESCE(singleton_key,'')) WHERE state =
 * 'created'`) enforces at most one *pending* copy per `singletonKey` (= action name) across the
 * whole cluster, with no leader. See {@link PgBossBackend} for why.
 */
const RECURRING_QUEUE = "keryx__recurring";

/** Reject anything that isn't a safe SQL identifier before interpolating it as a schema name. */
function assertSafeSchema(schema: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new TypedError({
      type: ErrorType.SERVER_INITIALIZATION,
      message: `invalid pg-boss schema name "${schema}" (must match [a-zA-Z_][a-zA-Z0-9_]*)`,
    });
  }
  return schema;
}

/**
 * A Postgres-backed {@link TaskBackend} built on [pg-boss](https://github.com/timgit/pg-boss).
 * Lets a deployment run background tasks without Redis. pg-boss owns and migrates its own schema
 * (`config.tasks.pgBoss.schema`) and uses `SKIP LOCKED` for exactly-once delivery.
 *
 * **Mapping to keryx's model:** each keryx queue string maps directly to a pg-boss queue; the action
 * name rides along in the job payload as `_actionName`, and one worker per queue dispatches by that
 * field — mirroring node-resque's "a queue holds heterogeneous jobs, the worker picks the class"
 * shape. Introspection that pg-boss doesn't expose through its API (`queued`, `scheduledAt`, `del`,
 * `delDelayed`, failed-job details) is read via parameterized SQL against pg-boss's own `job` table,
 * reusing keryx's Postgres pool (`api.db.pool`).
 *
 * **Recurring tasks without a leader:** node-resque keeps a recurring job single-instance via its
 * Redis `QueueLock`/`DelayQueueLock` plugins (not the scheduler leader). The equivalent here is the
 * dedicated {@link RECURRING_QUEUE}, created with pg-boss's `short` policy: its unique index only
 * permits one `created` (pending) job per `singletonKey`, and frees that slot the instant the job
 * goes `active`. Recurring actions enqueue there keyed by action name, so across any number of
 * processes exactly one pending copy exists, and the self-re-enqueue in the job's `finally` still
 * succeeds because the running copy no longer occupies the pending slot.
 *
 * Deliberately unsupported (node-resque Redis-isms): `locks`/`delLock`/`timestamps`/`delayedAt`/
 * `allDelayed`/`workingOn`/`cleanOldWorkers`/`delByFunction`/`delQueue` are omitted; `api.actions.*`
 * degrades those to empty results on this backend.
 */
export class PgBossBackend extends TaskBackend {
  private boss?: PgBoss;
  private taskRunner: TaskRunner;
  private schema: string;
  /** Queues we've already `createQueue`d, so we don't re-issue it on every enqueue. */
  private knownQueues = new Set<string>();
  /** Queues we've registered a `boss.work` handler for. */
  private workerQueues = new Set<string>();
  private workersRunning = false;

  constructor(taskRunner: TaskRunner) {
    super();
    this.taskRunner = taskRunner;
    this.schema = assertSafeSchema(config.tasks.pgBoss.schema ?? "keryx_tasks");
  }

  private get instance(): PgBoss {
    if (!this.boss) {
      throw new TypedError({
        type: ErrorType.CONNECTION_ACTION_RUN,
        message: "pg-boss backend used before start()",
      });
    }
    return this.boss;
  }

  /** Fully-qualified, quoted pg-boss job table. */
  private table() {
    return `"${this.schema}".job`;
  }

  /** Run parameterized SQL against pg-boss's tables via keryx's shared Postgres pool. */
  private query<T extends Record<string, any> = any>(
    text: string,
    values: any[] = [],
  ) {
    return api.db.pool.query<T>(text, values);
  }

  /** Merge the action name into the job payload so a single per-queue worker can dispatch it. */
  private withAction(actionName: string, inputs: TaskInputs) {
    return { ...inputs, _actionName: actionName };
  }

  /** Is this action recurring (has a positive `task.frequency`)? */
  private isRecurring(actionName: string): boolean {
    const action = api.actions.actions.find((a) => a.name === actionName);
    return !!(action?.task?.frequency && action.task.frequency > 0);
  }

  /**
   * Recurring actions live on the dedicated {@link RECURRING_QUEUE} (short policy, deduped by
   * action name) so only one pending copy exists cluster-wide; everything else uses its own queue.
   */
  private resolveQueue(queue: string, actionName: string): string {
    return this.isRecurring(actionName) ? RECURRING_QUEUE : queue;
  }

  private sendOptions(actionName: string) {
    const options: { retryLimit: number; singletonKey?: string } = {
      retryLimit: config.tasks.pgBoss.retryLimit,
    };
    // On the short-policy recurring queue, the singletonKey is what makes each action's
    // single-pending-instance guarantee per-action rather than per-queue.
    if (this.isRecurring(actionName)) options.singletonKey = actionName;
    return options;
  }

  /** Split a stored job row back into the normalized {@link QueuedJob} shape. */
  private toQueuedJob(row: { name: string; data: any }): QueuedJob {
    const data = (row.data ?? {}) as TaskInputs;
    const { _actionName, ...args } = data;
    return {
      class: typeof _actionName === "string" ? _actionName : row.name,
      queue: row.name,
      args: [args],
    };
  }

  /**
   * All queues the workers should cover: DEFAULT_QUEUE, the recurring queue, every action's queue,
   * and any created so far.
   */
  private actionQueues(): string[] {
    const set = new Set<string>([
      DEFAULT_QUEUE,
      RECURRING_QUEUE,
      ...this.knownQueues,
    ]);
    for (const action of api.actions.actions) {
      if (action.task?.queue) set.add(action.task.queue);
    }
    return [...set];
  }

  private async ensureQueue(queue: string) {
    if (this.knownQueues.has(queue)) return;
    try {
      // createQueue upserts, so this is safe to call for an existing queue. The recurring queue
      // uses the `short` policy so at most one pending job per singletonKey (action) can exist.
      await this.instance.createQueue(queue, {
        ...(queue === RECURRING_QUEUE ? { policy: "short" as const } : {}),
        retryLimit: config.tasks.pgBoss.retryLimit,
        deleteAfterSeconds: config.tasks.pgBoss.deleteAfterSeconds,
      });
    } catch (e) {
      logger.debug(`[pg-boss] createQueue ${queue}: ${e}`);
    }
    this.knownQueues.add(queue);
    if (this.workersRunning) await this.registerWorker(queue);
  }

  private async registerWorker(queue: string) {
    if (this.workerQueues.has(queue)) return;
    const pollingIntervalSeconds = Math.max(0.5, config.tasks.timeout / 1000);
    await this.instance.work<TaskInputs>(
      queue,
      {
        batchSize: 1,
        pollingIntervalSeconds,
        localConcurrency: config.tasks.taskProcessors,
      },
      async (jobs: Job<TaskInputs>[]) => {
        const job = jobs[0];
        if (!job) return;
        const data = (job.data ?? {}) as TaskInputs;
        const { _actionName, ...inputs } = data;
        // Throwing propagates to pg-boss, which fails (and, per retryLimit, retries) the job.
        await this.taskRunner(String(_actionName), inputs, { queue });
      },
    );
    this.workerQueues.add(queue);
  }

  async start(mode: RUN_MODE) {
    this.boss = new PgBoss({
      connectionString: config.database.connectionString,
      schema: this.schema,
      // keryx manages recurring tasks itself (via enqueueRecurrent), so pg-boss's own cron is off.
      schedule: false,
      // Maintenance (archival/deletion) only needs to run on job-working processes.
      supervise: mode === RUN_MODE.SERVER,
    });

    this.boss.on("error", (error: Error) => {
      logger.error(`[pg-boss] ${error}`);
    });

    await this.boss.start();

    for (const queue of this.actionQueues()) {
      await this.ensureQueue(queue);
    }

    if (mode === RUN_MODE.SERVER) {
      await this.startScheduler();
      await this.startWorkers();
    }
  }

  async stop(mode: RUN_MODE) {
    if (!this.boss) return;
    if (mode === RUN_MODE.SERVER) {
      await this.stopWorkers();
      await this.stopScheduler();
    }

    const boss = this.boss;
    const stopped = new Promise<void>((resolve) =>
      boss.once("stopped", () => resolve()),
    );
    await boss.stop({ graceful: true, timeout: 2000 });
    // Guard against a missed 'stopped' event so shutdown never hangs.
    await Promise.race([stopped, Bun.sleep(3000)]);

    this.boss = undefined;
    this.knownQueues.clear();
    this.workerQueues.clear();
    this.workersRunning = false;
  }

  async startWorkers() {
    this.workersRunning = true;
    if (config.tasks.taskProcessors < 1) return;
    for (const queue of this.actionQueues()) {
      await this.ensureQueue(queue);
      await this.registerWorker(queue);
    }
  }

  async stopWorkers() {
    this.workersRunning = false;
    if (!this.boss) return;
    for (const queue of this.workerQueues) {
      try {
        await this.boss.offWork(queue);
      } catch (e) {
        logger.debug(`[pg-boss] offWork ${queue}: ${e}`);
      }
    }
    this.workerQueues.clear();
  }

  async startScheduler() {
    if (config.tasks.enabled === true) {
      await api.actions.enqueueAllRecurrent();
    }
  }

  async stopScheduler() {
    // pg-boss self-manages delayed-job promotion; nothing to tear down.
  }

  registerAction(_action: Action) {
    // No-op: pg-boss dispatches dynamically by `_actionName`, and queues are created lazily on
    // enqueue / startWorkers, so there's no per-action wiring to build here.
  }

  unregisterAction(_actionName: string) {
    // No-op (see registerAction).
  }

  // --- Enqueue ---

  enqueue = async (queue: string, actionName: string, inputs: TaskInputs) => {
    const target = this.resolveQueue(queue, actionName);
    await this.ensureQueue(target);
    const id = await this.instance.send(
      target,
      this.withAction(actionName, inputs),
      this.sendOptions(actionName),
    );
    return id !== null;
  };

  enqueueAt = async (
    timestamp: number,
    queue: string,
    actionName: string,
    inputs: TaskInputs,
    _suppressDuplicateTaskError = false,
  ) => {
    const target = this.resolveQueue(queue, actionName);
    await this.ensureQueue(target);
    const id = await this.instance.send(
      target,
      this.withAction(actionName, inputs),
      {
        ...this.sendOptions(actionName),
        startAfter: new Date(timestamp),
      },
    );
    return id !== null;
  };

  enqueueIn = async (
    milliseconds: number,
    queue: string,
    actionName: string,
    inputs: TaskInputs,
    _suppressDuplicateTaskError = false,
  ) => {
    const target = this.resolveQueue(queue, actionName);
    await this.ensureQueue(target);
    const id = await this.instance.send(
      target,
      this.withAction(actionName, inputs),
      {
        ...this.sendOptions(actionName),
        startAfter: Math.max(0, milliseconds / 1000),
      },
    );
    return id !== null;
  };

  // --- Introspection / management (via SQL on pg-boss's own tables) ---

  queued = async (queue: string, start: number, stop: number) => {
    const { rows } = await this.query<{ name: string; data: any }>(
      `SELECT name, data FROM ${this.table()}
       WHERE name = $1 AND state IN ('created', 'retry') AND start_after <= now()
       ORDER BY created_on OFFSET $2 LIMIT $3`,
      [queue, start, Math.max(0, stop - start + 1)],
    );
    return rows.map((r) => this.toQueuedJob(r));
  };

  del = async (
    queue: string,
    actionName: string,
    inputs?: TaskInputs,
    count?: number,
  ) => {
    const params: any[] = [this.resolveQueue(queue, actionName), actionName];
    let where = `name = $1 AND state IN ('created', 'retry') AND start_after <= now() AND data->>'_actionName' = $2`;
    if (inputs !== undefined) {
      params.push(JSON.stringify(inputs));
      where += ` AND data @> $${params.length}::jsonb`;
    }
    let limit = "";
    if (count && count > 0) {
      params.push(count);
      limit = `LIMIT $${params.length}`;
    }
    const { rowCount } = await this.query(
      `DELETE FROM ${this.table()} WHERE id IN (
         SELECT id FROM ${this.table()} WHERE ${where} ORDER BY created_on ${limit}
       )`,
      params,
    );
    return rowCount ?? 0;
  };

  delDelayed = async (
    queue: string,
    actionName: string,
    inputs?: TaskInputs,
  ) => {
    const params: any[] = [this.resolveQueue(queue, actionName), actionName];
    let where = `name = $1 AND state IN ('created', 'retry') AND start_after > now() AND data->>'_actionName' = $2`;
    if (inputs !== undefined) {
      params.push(JSON.stringify(inputs));
      where += ` AND data @> $${params.length}::jsonb`;
    }
    const { rows } = await this.query<{ start_after: string }>(
      `DELETE FROM ${this.table()} WHERE ${where} RETURNING start_after`,
      params,
    );
    return rows.map((r) =>
      Math.floor(new Date(r.start_after).getTime() / 1000),
    );
  };

  scheduledAt = async (
    queue: string,
    actionName: string,
    inputs: TaskInputs,
  ) => {
    const { rows } = await this.query<{ start_after: string }>(
      `SELECT start_after FROM ${this.table()}
       WHERE name = $1 AND state IN ('created', 'retry') AND start_after > now()
         AND data->>'_actionName' = $2 AND data @> $3::jsonb
       ORDER BY start_after`,
      [
        this.resolveQueue(queue, actionName),
        actionName,
        JSON.stringify(inputs),
      ],
    );
    return rows.map((r) =>
      Math.floor(new Date(r.start_after).getTime() / 1000),
    );
  };

  stats = async () => {
    const { rows } = await this.query<{ state: string; count: number }>(
      `SELECT state, count(*)::int AS count FROM ${this.table()} GROUP BY state`,
    );
    const byState: Record<string, number> = {};
    for (const r of rows) byState[r.state] = r.count;
    return {
      processed: byState.completed ?? 0,
      failed: byState.failed ?? 0,
      ...byState,
    };
  };

  queues = async () => {
    const qs = await this.instance.getQueues();
    return qs.map((q) => q.name);
  };

  queueLength = async (queue: string) => {
    const { rows } = await this.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ${this.table()}
       WHERE name = $1 AND state IN ('created', 'retry')`,
      [queue],
    );
    return rows[0]?.c ?? 0;
  };

  getWorkers = async () => {
    const wip = this.boss ? this.boss.getWipData() : [];
    return Object.fromEntries(wip.map((w) => [w.workId, w]));
  };

  allWorkingOn = async () => {
    const { rows } = await this.query<{ id: string; name: string; data: any }>(
      `SELECT id, name, data FROM ${this.table()} WHERE state = 'active'`,
    );
    return Object.fromEntries(
      rows.map((r) => [r.id, { queue: r.name, payload: this.toQueuedJob(r) }]),
    );
  };

  // pg-boss has no leader/coordinator concept.
  leader = async () => "";

  failedCount = async () => {
    const { rows } = await this.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ${this.table()} WHERE state = 'failed'`,
    );
    return rows[0]?.c ?? 0;
  };

  failed = async (start: number, stop: number): Promise<FailedJob[]> => {
    const { rows } = await this.query<{
      id: string;
      name: string;
      data: any;
      output: any;
      completed_on: string | null;
    }>(
      `SELECT id, name, data, output, completed_on FROM ${this.table()}
       WHERE state = 'failed' ORDER BY completed_on DESC NULLS LAST OFFSET $1 LIMIT $2`,
      [start, Math.max(0, stop - start + 1)],
    );
    return rows.map((r) => {
      const { _actionName, ...args } = (r.data ?? {}) as TaskInputs;
      const output = r.output ?? {};
      const message =
        output && typeof output === "object" && "message" in output
          ? String(output.message)
          : String(output);
      const stack =
        output && typeof output === "object" && "stack" in output
          ? String(output.stack).split("\n")
          : null;
      return {
        id: r.id,
        queue: r.name,
        payload: {
          class: typeof _actionName === "string" ? _actionName : r.name,
          queue: r.name,
          args: [args],
        },
        error: message,
        exception:
          output && typeof output === "object" && "name" in output
            ? String(output.name)
            : undefined,
        backtrace: stack,
        worker: "",
        failed_at: r.completed_on
          ? new Date(r.completed_on).toISOString()
          : undefined,
      };
    });
  };

  removeFailed = async (failedJob: FailedJob) => {
    if (!failedJob.id) return;
    await this.query(`DELETE FROM ${this.table()} WHERE id = $1`, [
      failedJob.id,
    ]);
  };

  retryAndRemoveFailed = async (failedJob: FailedJob) => {
    if (!failedJob.id) return;
    await this.instance.retry(failedJob.queue, failedJob.id);
  };
}
