import {
  type CreateTaskOptions,
  isTerminal,
  type TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks";
import {
  type CallToolResult,
  ErrorCode,
  McpError,
  type Request,
  type RequestId,
  type Task,
} from "@modelcontextprotocol/sdk/types.js";
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { api, logger } from "../api";
import type { Action, McpTaskState, McpTaskStatus } from "../classes/Action";
import { CONNECTION_TYPE, Connection } from "../classes/Connection";
import { config } from "../config";
import type { McpSessionAuth } from "./mcpServer";
import { toCallToolResult, toolErrorResult } from "./mcpToolResult";

const UPDATE_MCP_TASK_LUA = await Bun.file(
  join(import.meta.dir, "..", "lua", "update-mcp-task.lua"),
).text();

/** How many tasks one `tasks/list` page holds. */
export const MCP_TASK_LIST_PAGE_SIZE = 50;

/** How many times a task write re-reads and retries after losing a race. */
const MAX_UPDATE_ATTEMPTS = 5;

/** Redis key for one task record. */
export function mcpTaskKey(taskId: string): string {
  return `mcp:task:${taskId}`;
}

/** Redis key for an owner's task index (a sorted set of task ids by creation time). */
function mcpTaskIndexKey(ownerKey: string): string {
  return `mcp:tasks:${ownerKey}`;
}

/**
 * Who a task belongs to. Tasks are bound to the authenticated principal — the
 * OAuth client **and** the user — rather than to the `Mcp-Session-Id`, so a
 * client that reconnects (a new session, possibly on another node) still sees
 * its tasks, and nobody else ever does. An anonymous session has no principal,
 * so its tasks are bound to the session itself.
 */
export type McpTaskOwner = {
  /** Opaque, stable key for the principal (a hash; safe in a Redis key). */
  key: string;
  /** The session's auth context, used to act as the owner on later checks. */
  auth: McpSessionAuth;
};

/**
 * Derive the {@link McpTaskOwner} for a session's auth context.
 *
 * @param auth - The session's captured auth context.
 * @param anonymous - Whether the session is anonymous.
 * @param sessionId - The session id; the binding for anonymous sessions.
 * @returns The owner, or `undefined` for an anonymous session with no id yet.
 */
export function mcpTaskOwnerFor(
  auth: McpSessionAuth,
  anonymous: boolean,
  sessionId: string | undefined,
): McpTaskOwner | undefined {
  let principal: string;
  if (anonymous) {
    if (!sessionId) return undefined;
    principal = JSON.stringify(["session", sessionId]);
  } else {
    principal = JSON.stringify([
      "client",
      auth.clientId,
      auth.userId == null ? null : String(auth.userId),
    ]);
  }
  return {
    key: createHash("sha256").update(principal).digest("hex"),
    auth,
  };
}

/** A task as persisted in Redis. */
type McpTaskRecord = {
  /** The MCP task object served by `tasks/get` and `tasks/list`. */
  task: Task;
  /** {@link McpTaskOwner.key} of the principal that created it. */
  owner: string;
  /** Name of the action the task runs. */
  action: string;
  /** A durable task's handle: what the action returned when the task was created. */
  handle?: unknown;
  /** The `tasks/result` payload, once the task is terminal. */
  result?: CallToolResult;
};

/** Background runs of managed tasks still in flight on this node. */
const inFlight = new Set<Promise<void>>();

/**
 * Wait for every managed task still running in the background on this node to
 * record its result. Called when the MCP initializer stops, so a shutdown does
 * not strand a task as `working` when its result was moments away.
 */
export async function settleMcpTasks(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/**
 * Build a connection that acts as a task's owner, for a durable task's
 * `status` / `cancel` callbacks. Like the channel-authorization probe, its
 * session lives in memory only, so polling a task writes no session to Redis.
 *
 * @param auth - The owner's auth context.
 */
function createOwnerConnection(auth: McpSessionAuth): Connection {
  const connection = new Connection(
    CONNECTION_TYPE.MCP,
    auth.ip ?? "unknown",
    randomUUID(),
  );
  connection.session = {
    id: connection.sessionId,
    cookieName: config.session.cookieName,
    createdAt: Date.now(),
    data: auth.userId != null ? { userId: auth.userId } : {},
  };
  connection.sessionLoaded = true;
  return connection;
}

/** The `tasks/result` payload for a task cancelled before it produced one. */
function cancelledResult(statusMessage?: string): CallToolResult {
  return toolErrorResult({
    message: statusMessage ?? "Task was cancelled.",
  });
}

/**
 * Whether a request asked for task-augmented execution (`params.task` set).
 * Not the SDK's `isTaskAugmentedRequestParams`: `task` is optional in the
 * schema it validates against, so it is true of every request.
 */
function asksForTask(request: Request): boolean {
  const task = (request.params as { task?: unknown } | undefined)?.task;
  return task !== null && typeof task === "object";
}

/** The status a finished run's result implies. */
function statusOf(result: CallToolResult): "completed" | "failed" {
  return result.isError ? "failed" : "completed";
}

function findAction(name: string): Action | undefined {
  return api.actions.actions.find((a: Action) => a.name === name);
}

/**
 * The `TaskStore` behind MCP Tasks — one per `McpServer` (that is, per
 * session), backed by Redis so a task can be read from any node and outlive the
 * session that created it.
 *
 * The SDK answers `tasks/get`, `tasks/result`, `tasks/list`, and `tasks/cancel`
 * from this store, passing at most the session id. Every read is therefore
 * scoped to the session's **owner** (resolved fresh on each call, so a session
 * that signs in mid-way is re-scoped), and a task owned by anybody else reads
 * exactly like an unknown id.
 *
 * Two task kinds share the store (see `McpTaskConfig`): a **managed** task's
 * result is written by its background run; a **durable** task's state is
 * pulled from the action's `status` callback whenever a non-terminal task is
 * read. Every write is a compare-and-set, so a terminal status is final.
 */
export class McpTaskStore implements TaskStore {
  /** Tasks minted by `createTask` and not yet claimed by the tool handler. */
  private minted = new Map<string, { task: Task; inline: boolean }>();
  /** Results of plain (non-task) calls to `optional` tools; never persisted. */
  private inline = new Map<string, { task: Task; result: CallToolResult }>();

  /**
   * @param resolveOwner - Returns the session's current owner, or `undefined`
   *   if it has none (no auth context): every read then fails closed.
   */
  constructor(private readonly resolveOwner: () => McpTaskOwner | undefined) {}

  /**
   * Mint a task id for a `tools/call`. Nothing is persisted yet: the tool
   * handler {@link claim}s the task and then either finishes it inline or
   * {@link save}s it. This is also where a plain call to an `optional` tool is
   * told apart from a task-augmented one — the SDK routes both through task
   * creation, and only the original request says which it was.
   *
   * @param taskParams - The client's requested `ttl` (ms) and our poll interval.
   * @param _requestId - The JSON-RPC request id (unused).
   * @param request - The original `tools/call` request.
   */
  async createTask(
    taskParams: CreateTaskOptions,
    _requestId: RequestId,
    request: Request,
  ): Promise<Task> {
    const now = new Date().toISOString();
    const maxTtl = config.server.mcp.taskMaxTtl * 1000;
    const requested = taskParams.ttl ?? config.server.mcp.taskTtl * 1000;
    const task: Task = {
      taskId: randomUUID(),
      status: "working",
      ttl: Math.max(1000, Math.min(requested, maxTtl)),
      createdAt: now,
      lastUpdatedAt: now,
      pollInterval:
        taskParams.pollInterval ?? config.server.mcp.taskPollInterval,
    };
    this.minted.set(task.taskId, {
      task,
      inline: !asksForTask(request),
    });
    return task;
  }

  /**
   * Take a task minted by {@link createTask} for the current call.
   *
   * @param taskId - The id `createTask` returned.
   * @returns The task, and whether the call was a plain (non-task) call that
   *   must be answered inline.
   */
  claim(taskId: string): { task: Task; inline: boolean } {
    const minted = this.minted.get(taskId);
    if (!minted) {
      throw new McpError(ErrorCode.InternalError, `Unknown task ${taskId}`);
    }
    this.minted.delete(taskId);
    return minted;
  }

  /**
   * Finish a plain call to an `optional` tool. The SDK still polls the task it
   * made for the call, so hand it a terminal task whose result is held in
   * memory until the SDK collects it — immediately, in the same request.
   *
   * @param task - The claimed task.
   * @param result - The tool result to return to the caller.
   * @returns The terminal task.
   */
  finishInline(task: Task, result: CallToolResult): Task {
    const finished: Task = { ...task, status: statusOf(result) };
    this.inline.set(task.taskId, { task: finished, result });
    return finished;
  }

  /**
   * Persist a new task for the session's owner and add it to the owner's index.
   *
   * @param task - The claimed task, with the status it starts in.
   * @param action - The action the task runs.
   * @param fields - A durable task's `handle`, or a `result` if it is already terminal.
   * @returns The persisted task.
   * @throws {McpError} If the session has no owner to bind the task to.
   */
  async save(
    task: Task,
    action: Action,
    fields: { handle?: unknown; result?: CallToolResult } = {},
  ): Promise<Task> {
    const owner = this.resolveOwner();
    if (!owner) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "This session cannot create tasks.",
      );
    }
    const record: McpTaskRecord = {
      task,
      owner: owner.key,
      action: action.name,
      ...fields,
    };
    const indexKey = mcpTaskIndexKey(owner.key);
    await api.redis.redis
      .multi()
      .set(mcpTaskKey(task.taskId), JSON.stringify(record), "PX", task.ttl ?? 0)
      .zadd(indexKey, Date.parse(task.createdAt), task.taskId)
      .pexpire(indexKey, config.server.mcp.taskMaxTtl * 1000)
      .exec();
    return task;
  }

  /**
   * Track a managed task's background run on this node, recording its result
   * when it settles. A run that throws records a failure rather than leaving the
   * task `working` until it expires.
   *
   * @param taskId - The task the run belongs to.
   * @param run - Runs the action and renders its tool result.
   */
  runInBackground(taskId: string, run: () => Promise<CallToolResult>): void {
    const settled = (async () => {
      let result: CallToolResult;
      try {
        result = await run();
      } catch (error) {
        result = toolErrorResult({
          message: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await this.finish(taskId, result);
      } catch (error) {
        logger.error(`Failed to record result of MCP task ${taskId}: ${error}`);
      }
    })();
    inFlight.add(settled);
    settled.finally(() => inFlight.delete(settled));
  }

  /**
   * Record a terminal result unless the task is already terminal (e.g. it was
   * cancelled while running, in which case the result is discarded). Reads the
   * record without an owner check: the background run is the owner's own call.
   */
  private async finish(taskId: string, result: CallToolResult): Promise<void> {
    await this.update(taskId, undefined, (record) => ({
      ...record,
      task: this.advance(record.task, statusOf(result)),
      result,
    }));
  }

  /**
   * Read a task for `tasks/get` (and while `tasks/result` waits). A durable
   * task that is not yet terminal is refreshed from its action's `status`
   * callback first.
   *
   * @param taskId - The task id.
   * @returns The task, or `null` if it is unknown, expired, or not this owner's.
   */
  async getTask(taskId: string): Promise<Task | null> {
    const inline = this.inline.get(taskId);
    if (inline) return inline.task;

    const owner = this.resolveOwner();
    if (!owner) return null;
    const record = await this.read(taskId, owner);
    if (!record) return null;
    if (isTerminal(record.task.status)) return record.task;

    const action = findAction(record.action);
    const status = action?.mcp?.task?.status;
    if (!action || !status) return record.task;

    let state: McpTaskState;
    const connection = createOwnerConnection(owner.auth);
    try {
      state = await status(record.handle, connection);
    } catch (error) {
      logger.warn(
        `MCP task ${taskId} (${record.action}) status check failed: ${error}`,
      );
      return record.task;
    } finally {
      connection.destroy();
    }

    if (
      state.status === record.task.status &&
      state.statusMessage === record.task.statusMessage
    ) {
      return record.task;
    }

    let result: CallToolResult | undefined;
    if (state.status === "cancelled") {
      result = cancelledResult(state.statusMessage);
    } else if (state.status === "completed" || state.status === "failed") {
      result = await toCallToolResult(
        action,
        state.result !== undefined ? state.result : record.handle,
      );
      if (state.status === "failed") result = { ...result, isError: true };
    }

    const updated = await this.update(taskId, owner, (current) => ({
      ...current,
      task: this.advance(current.task, state.status, state.statusMessage),
      ...(result ? { result } : {}),
    }));
    return updated?.task ?? null;
  }

  /**
   * The `tasks/result` payload of a terminal task. The SDK only asks once the
   * task is terminal.
   *
   * @param taskId - The task id.
   * @throws {McpError} If the task is unknown, not this owner's, or not finished.
   */
  async getTaskResult(taskId: string): Promise<CallToolResult> {
    const inline = this.inline.get(taskId);
    if (inline) {
      this.inline.delete(taskId);
      return inline.result;
    }

    const owner = this.resolveOwner();
    const record = owner ? await this.read(taskId, owner) : null;
    if (!record) {
      throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
    }
    if (record.result) return record.result;
    if (record.task.status === "cancelled") {
      return cancelledResult(record.task.statusMessage);
    }
    throw new McpError(
      ErrorCode.InvalidParams,
      `Task ${taskId} has no result yet (status: ${record.task.status})`,
    );
  }

  /**
   * Store a task's final result. Part of the SDK's `TaskStore` contract;
   * Keryx's own tool handlers record results through {@link runInBackground}.
   */
  async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: CallToolResult,
  ): Promise<void> {
    const owner = this.resolveOwner();
    if (!owner) return;
    await this.update(taskId, owner, (record) => ({
      ...record,
      task: this.advance(record.task, status),
      result,
    }));
  }

  /**
   * Change a task's status. The SDK calls this for `tasks/cancel` (after
   * checking the task is not terminal), which is where a durable task's
   * `cancel` callback runs — before the task is marked, so a callback that
   * throws leaves the task running and the client sees the error.
   *
   * @param taskId - The task id.
   * @param status - The new status.
   * @param statusMessage - Optional detail for the client.
   * @throws {McpError} If the task is unknown or not this owner's, or the
   *   action's `cancel` callback refused.
   */
  async updateTaskStatus(
    taskId: string,
    status: McpTaskStatus,
    statusMessage?: string,
  ): Promise<void> {
    const owner = this.resolveOwner();
    const record = owner ? await this.read(taskId, owner) : null;
    if (!owner || !record) {
      throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
    }
    if (isTerminal(record.task.status)) return;

    if (status === "cancelled") {
      const cancel = findAction(record.action)?.mcp?.task?.cancel;
      if (cancel) {
        const connection = createOwnerConnection(owner.auth);
        try {
          await cancel(record.handle, connection);
        } catch (error) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Failed to cancel task: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          connection.destroy();
        }
      }
    }

    await this.update(taskId, owner, (current) => ({
      ...current,
      task: this.advance(current.task, status, statusMessage),
      ...(status === "cancelled"
        ? { result: cancelledResult(statusMessage) }
        : {}),
    }));
  }

  /**
   * List the owner's tasks, newest first, with their last recorded status
   * (`tasks/get` is what refreshes a durable task). Expired entries are pruned
   * from the index as they are found.
   *
   * @param cursor - The `nextCursor` of the previous page, if any.
   * @throws {Error} If `cursor` is not one this store issued.
   */
  async listTasks(
    cursor?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const owner = this.resolveOwner();
    if (!owner) return { tasks: [] };
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error(`Invalid cursor: ${cursor}`);
    }

    const indexKey = mcpTaskIndexKey(owner.key);
    const ids = await api.redis.redis.zrevrange(
      indexKey,
      offset,
      offset + MCP_TASK_LIST_PAGE_SIZE - 1,
    );
    if (ids.length === 0) return { tasks: [] };

    const raws = await api.redis.redis.mget(ids.map(mcpTaskKey));
    const tasks: Task[] = [];
    const expired: string[] = [];
    raws.forEach((raw, i) => {
      const record = raw ? (JSON.parse(raw) as McpTaskRecord) : null;
      if (record && record.owner === owner.key) tasks.push(record.task);
      else expired.push(ids[i]);
    });
    if (expired.length > 0) await api.redis.redis.zrem(indexKey, ...expired);

    // Pruned entries shift everything after them up, so the next page starts
    // that much earlier.
    return ids.length === MCP_TASK_LIST_PAGE_SIZE
      ? { tasks, nextCursor: String(offset + ids.length - expired.length) }
      : { tasks };
  }

  /** The task after a status change, stamped with the time of the change. */
  private advance(
    task: Task,
    status: McpTaskStatus,
    statusMessage?: string,
  ): Task {
    const next: Task = {
      ...task,
      status,
      lastUpdatedAt: new Date().toISOString(),
    };
    if (statusMessage !== undefined) next.statusMessage = statusMessage;
    else delete next.statusMessage;
    return next;
  }

  /** Read a record, or `null` if it is missing or belongs to someone else. */
  private async read(
    taskId: string,
    owner: McpTaskOwner,
  ): Promise<McpTaskRecord | null> {
    const raw = await api.redis.redis.get(mcpTaskKey(taskId));
    if (!raw) return null;
    const record = JSON.parse(raw) as McpTaskRecord;
    return record.owner === owner.key ? record : null;
  }

  /**
   * Compare-and-set a record, retrying on a lost race. A record that is
   * already terminal is never rewritten.
   *
   * @param taskId - The task id.
   * @param owner - Restrict to this owner's record; `undefined` skips the check
   *   (only for a background run writing its own task).
   * @param mutate - Builds the new record from the current one.
   * @returns The record as written, the terminal record if it already was, or
   *   `null` if the task is gone.
   */
  private async update(
    taskId: string,
    owner: McpTaskOwner | undefined,
    mutate: (record: McpTaskRecord) => McpTaskRecord,
  ): Promise<McpTaskRecord | null> {
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      const raw = await api.redis.redis.get(mcpTaskKey(taskId));
      if (!raw) return null;
      const record = JSON.parse(raw) as McpTaskRecord;
      if (owner && record.owner !== owner.key) return null;
      if (isTerminal(record.task.status)) return record;
      const next = mutate(record);
      const written = await api.redis.redis.eval(
        UPDATE_MCP_TASK_LUA,
        1,
        mcpTaskKey(taskId),
        raw,
        JSON.stringify(next),
      );
      if (written === 1) return next;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Task ${taskId} is being updated concurrently; try again.`,
    );
  }
}
