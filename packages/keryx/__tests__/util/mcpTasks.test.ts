import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  McpError,
  type Task,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { api } from "../../api";
import { Action, type McpTaskState } from "../../classes/Action";
import type { Connection } from "../../classes/Connection";
import { ErrorType, TypedError } from "../../classes/TypedError";
import { config } from "../../config";
import { MCP_TASK_LIST_PAGE_SIZE, mcpTaskKey } from "../../util/mcpTasks";
import { serverUrl, useTestServer, waitFor } from "../setup";

const mcpUrl = () => `${serverUrl()}${config.server.mcp.route}`;

/** Releases for in-flight managed runs, keyed by the `gate` argument. */
const gates = new Map<string, () => void>();
/** How many managed runs have finished, keyed by `gate`. */
const finished = new Map<string, number>();

/** A managed task tool: runs until the test opens its gate. */
class TestManagedTask extends Action {
  constructor() {
    super({
      name: "test:task-managed",
      description: "Waits for a gate, then echoes",
      inputs: z.object({ gate: z.string(), echo: z.string() }),
      mcp: { tool: true, task: { support: "optional", pollInterval: 50 } },
    });
  }

  async run(params: { gate: string; echo: string }) {
    if (params.gate !== "open") {
      await new Promise<void>((resolve) => gates.set(params.gate, resolve));
    }
    finished.set(params.gate, (finished.get(params.gate) ?? 0) + 1);
    return { echo: params.echo };
  }
}

/** A managed task tool whose action always fails. */
class TestFailingTask extends Action {
  constructor() {
    super({
      name: "test:task-failing",
      inputs: z.object({}),
      mcp: { tool: true, task: { support: "optional", pollInterval: 50 } },
    });
  }

  async run(): Promise<never> {
    throw new TypedError({
      message: "this action always fails",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
}

/** The durable work behind `test:task-durable`, keyed by job id. */
type Job = {
  state: McpTaskState;
  statusCalls: number;
  cancelCalls: number;
  refuseCancel?: boolean;
  throwOnStatus?: boolean;
  seenUserId?: unknown;
};
const jobs = new Map<string, Job>();

/** A durable task tool: state comes from `jobs`, as an app's own rows would. */
class TestDurableTask extends Action {
  constructor() {
    super({
      name: "test:task-durable",
      inputs: z.object({ jobId: z.string() }),
      mcp: {
        tool: true,
        task: {
          support: "required",
          pollInterval: 50,
          status: (response: { jobId: string }, connection: Connection) => {
            const job = jobs.get(response.jobId)!;
            job.statusCalls++;
            job.seenUserId = connection.session?.data.userId;
            if (job.throwOnStatus) throw new Error("storage unavailable");
            return job.state;
          },
          cancel: (response: { jobId: string }) => {
            const job = jobs.get(response.jobId)!;
            job.cancelCalls++;
            if (job.refuseCancel) throw new Error("job is past cancelling");
          },
        },
      },
    });
  }

  async run(params: { jobId: string }) {
    if (params.jobId === "reject") {
      throw new TypedError({
        message: "cannot start that job",
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
    jobs.set(params.jobId, {
      state: { status: "working" },
      statusCalls: 0,
      cancelCalls: 0,
    });
    return { jobId: params.jobId, startedBy: "test" };
  }
}

/** A plain tool, for comparing a task tool's inline answer against. */
class TestPlainEcho extends Action {
  constructor() {
    super({
      name: "test:plain-echo",
      inputs: z.object({ gate: z.string(), echo: z.string() }),
      mcp: { tool: true },
    });
  }

  async run(params: { echo: string }) {
    return { echo: params.echo };
  }
}

/** Mint a bearer token for `userId` on `clientId`, as the OAuth flow would. */
async function mintToken(userId: number, clientId = "test"): Promise<string> {
  const token = crypto.randomUUID();
  await api.redis.redis.set(
    `oauth:token:${token}`,
    JSON.stringify({ userId, clientId, scopes: [] }),
    "EX",
    300,
  );
  return token;
}

/**
 * A user id no earlier run has used. Task records outlive a test run in Redis,
 * so any assertion about a user's whole task list needs a user of its own.
 */
function freshUserId(): number {
  return 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
}

/** Open an MCP session with `token`. */
async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Call a tool as a task and return the created task. */
async function startTask(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  ttl?: number,
): Promise<Task> {
  const created = await client.request(
    {
      method: "tools/call",
      params: { name, arguments: args, task: ttl === undefined ? {} : { ttl } },
    },
    CreateTaskResultSchema,
  );
  return created.task;
}

/** `tasks/result` for a task. */
function taskResult(client: Client, taskId: string) {
  return client.request(
    { method: "tasks/result", params: { taskId } },
    CallToolResultSchema,
  );
}

/** The MCP error a call rejects with. */
async function mcpErrorOf(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

/** Wait until `tasks/get` reports `status`. */
async function waitForStatus(
  client: Client,
  taskId: string,
  status: Task["status"],
) {
  await waitFor(
    async () =>
      (await client.experimental.tasks.getTask(taskId)).status === status,
  );
}

describe("MCP tasks", () => {
  const testActions: Action[] = [
    new TestManagedTask(),
    new TestFailingTask(),
    new TestDurableTask(),
    new TestPlainEcho(),
  ];
  const clients: Client[] = [];
  const ownerId = freshUserId();
  let token: string;
  let client: Client;

  /** Connect and remember the client so it is closed after the suite. */
  async function session(withToken: string): Promise<Client> {
    const c = await connect(withToken);
    clients.push(c);
    return c;
  }

  beforeAll(() => {
    config.server.mcp.enabled = true;
  });

  useTestServer();

  beforeAll(async () => {
    api.actions.actions.push(...testActions);
    token = await mintToken(ownerId);
    client = await session(token);
  });

  afterAll(async () => {
    // Let any managed run still parked on a gate finish before teardown.
    for (const release of gates.values()) release();
    for (const c of clients) await c.close().catch(() => {});
    for (const action of testActions) {
      const idx = api.actions.actions.indexOf(action);
      if (idx !== -1) api.actions.actions.splice(idx, 1);
    }
    config.server.mcp.enabled = false;
  });

  describe("advertising", () => {
    test("the server declares the tasks capability", () => {
      expect(client.getServerCapabilities()?.tasks).toEqual({
        list: {},
        cancel: {},
        requests: { tools: { call: {} } },
      });
    });

    test("tools list each tool's task support", async () => {
      const { tools } = await client.listTools();
      const support = (name: string) =>
        tools.find((t) => t.name === name)?.execution?.taskSupport;
      expect(support("test-task-managed")).toBe("optional");
      expect(support("test-task-durable")).toBe("required");
      expect(support("test-plain-echo")).not.toBe("optional");
      expect(support("test-plain-echo")).not.toBe("required");
    });

    test("without a task-capable action, there is no tasks capability", async () => {
      const taskActions = testActions.filter((a) => a.mcp?.task);
      for (const action of taskActions) {
        api.actions.actions.splice(api.actions.actions.indexOf(action), 1);
      }
      try {
        const plain = await session(token);
        expect(plain.getServerCapabilities()?.tasks).toBeUndefined();
      } finally {
        api.actions.actions.push(...taskActions);
      }
    });
  });

  describe("an optional task tool called without a task", () => {
    test("answers exactly like a plain tool, in the same request", async () => {
      const args = { gate: "open", echo: "hello" };
      const asTask = await client.callTool({
        name: "test-task-managed",
        arguments: args,
      });
      const plain = await client.callTool({
        name: "test-plain-echo",
        arguments: args,
      });
      expect(asTask.content).toEqual(plain.content);
      expect(asTask.structuredContent).toEqual(plain.structuredContent);
      expect(asTask.isError).toBe(plain.isError);
    });

    test("leaves no task behind", async () => {
      const fresh = await session(await mintToken(freshUserId()));
      await fresh.callTool({
        name: "test-task-managed",
        arguments: { gate: "open", echo: "x" },
      });
      expect((await fresh.experimental.tasks.listTasks()).tasks).toEqual([]);
    });

    test("an action error is a tool error, not a failed task", async () => {
      const result = await client.callTool({
        name: "test-task-failing",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(
        JSON.parse((result.content as { text: string }[])[0].text),
      ).toEqual({
        error: "this action always fails",
        type: "CONNECTION_ACTION_RUN",
      });
    });
  });

  describe("managed tasks", () => {
    test("return a working task at once, then the result when the run ends", async () => {
      const task = await startTask(client, "test-task-managed", {
        gate: "managed-1",
        echo: "done",
      });
      expect(task.status).toBe("working");
      expect(task.pollInterval).toBe(50);
      expect(
        (await client.experimental.tasks.getTask(task.taskId)).status,
      ).toBe("working");

      await waitFor(() => gates.has("managed-1"));
      gates.get("managed-1")!();
      await waitForStatus(client, task.taskId, "completed");

      const result = await taskResult(client, task.taskId);
      expect(result.structuredContent).toEqual({ echo: "done" });
      expect(result._meta?.["io.modelcontextprotocol/related-task"]).toEqual({
        taskId: task.taskId,
      });
    });

    test("tasks/result blocks until the task finishes", async () => {
      const task = await startTask(client, "test-task-managed", {
        gate: "managed-2",
        echo: "waited",
      });
      const pending = taskResult(client, task.taskId);
      let settled = false;
      pending.then(() => {
        settled = true;
      });
      await waitFor(() => gates.has("managed-2"));
      await Bun.sleep(150);
      expect(settled).toBe(false);

      gates.get("managed-2")!();
      expect((await pending).structuredContent).toEqual({ echo: "waited" });
    });

    test("a failing action ends the task as failed with the error as its result", async () => {
      const task = await startTask(client, "test-task-failing", {});
      await waitForStatus(client, task.taskId, "failed");
      const result = await taskResult(client, task.taskId);
      expect(result.isError).toBe(true);
      expect(
        JSON.parse((result.content as { text: string }[])[0].text),
      ).toEqual({
        error: "this action always fails",
        type: "CONNECTION_ACTION_RUN",
      });
    });

    test("cancelling stops tracking, and the run's later result is discarded", async () => {
      const task = await startTask(client, "test-task-managed", {
        gate: "managed-3",
        echo: "too late",
      });
      const cancelled = await client.experimental.tasks.cancelTask(task.taskId);
      expect(cancelled.status).toBe("cancelled");

      await waitFor(() => gates.has("managed-3"));
      gates.get("managed-3")!();
      await waitFor(() => finished.get("managed-3") === 1);
      await Bun.sleep(50);

      expect(
        (await client.experimental.tasks.getTask(task.taskId)).status,
      ).toBe("cancelled");
      expect((await taskResult(client, task.taskId)).isError).toBe(true);
    });
  });

  describe("durable tasks", () => {
    test("a required task tool refuses a plain call", async () => {
      // Sent raw: the SDK client refuses this call itself, before the server
      // could, and it is the server's refusal under test.
      const result = await client.request(
        {
          method: "tools/call",
          params: { name: "test-task-durable", arguments: { jobId: "plain" } },
        },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain(
        "requires task augmentation",
      );
      expect(jobs.has("plain")).toBe(false);
    });

    test("report the app's state, as the task's owner, until it is terminal", async () => {
      const task = await startTask(client, "test-task-durable", {
        jobId: "job-1",
      });
      expect(task.status).toBe("working");
      const job = jobs.get("job-1")!;

      job.state = { status: "input_required", statusMessage: "needs review" };
      const waiting = await client.experimental.tasks.getTask(task.taskId);
      expect(waiting.status).toBe("input_required");
      expect(waiting.statusMessage).toBe("needs review");
      expect(job.seenUserId).toBe(ownerId);

      job.state = {
        status: "completed",
        result: { jobId: "job-1", outcome: "shipped" },
      };
      const done = await client.experimental.tasks.getTask(task.taskId);
      expect(done.status).toBe("completed");
      expect(done.statusMessage).toBeUndefined();

      const calls = job.statusCalls;
      job.state = { status: "working" };
      expect(
        (await client.experimental.tasks.getTask(task.taskId)).status,
      ).toBe("completed");
      expect(job.statusCalls).toBe(calls);

      expect((await taskResult(client, task.taskId)).structuredContent).toEqual(
        { jobId: "job-1", outcome: "shipped" },
      );
    });

    test("a terminal state without a result delivers the action's own response", async () => {
      const task = await startTask(client, "test-task-durable", {
        jobId: "job-2",
      });
      jobs.get("job-2")!.state = { status: "completed" };
      expect((await taskResult(client, task.taskId)).structuredContent).toEqual(
        { jobId: "job-2", startedBy: "test" },
      );
    });

    test("a failed state flags its result as an error", async () => {
      const task = await startTask(client, "test-task-durable", {
        jobId: "job-3",
      });
      jobs.get("job-3")!.state = {
        status: "failed",
        statusMessage: "step 2 failed",
        result: { jobId: "job-3", failedStep: 2 },
      };
      const failed = await client.experimental.tasks.getTask(task.taskId);
      expect(failed.status).toBe("failed");
      expect(failed.statusMessage).toBe("step 2 failed");
      const result = await taskResult(client, task.taskId);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        jobId: "job-3",
        failedStep: 2,
      });
    });

    test("an action that fails to start ends the task as failed at once", async () => {
      const task = await startTask(client, "test-task-durable", {
        jobId: "reject",
      });
      expect(task.status).toBe("failed");
      expect(task.statusMessage).toBe("cannot start that job");
      expect((await taskResult(client, task.taskId)).isError).toBe(true);
    });

    test("a status callback that throws keeps the last known state", async () => {
      const task = await startTask(client, "test-task-durable", {
        jobId: "job-4",
      });
      const job = jobs.get("job-4")!;
      job.state = { status: "input_required" };
      await client.experimental.tasks.getTask(task.taskId);
      job.throwOnStatus = true;
      expect(
        (await client.experimental.tasks.getTask(task.taskId)).status,
      ).toBe("input_required");
    });

    test("cancelling calls the action's cancel, then the task stays cancelled", async () => {
      const task = await startTask(client, "test-task-durable", {
        jobId: "job-5",
      });
      const job = jobs.get("job-5")!;
      const cancelled = await client.experimental.tasks.cancelTask(task.taskId);
      expect(cancelled.status).toBe("cancelled");
      expect(job.cancelCalls).toBe(1);

      job.state = { status: "completed" };
      expect(
        (await client.experimental.tasks.getTask(task.taskId)).status,
      ).toBe("cancelled");
      expect((await taskResult(client, task.taskId)).isError).toBe(true);
    });

    test("a cancel the action refuses is an error, and the task keeps running", async () => {
      const task = await startTask(client, "test-task-durable", {
        jobId: "job-6",
      });
      jobs.get("job-6")!.refuseCancel = true;
      const error = await mcpErrorOf(
        client.experimental.tasks.cancelTask(task.taskId),
      );
      expect(error.message).toContain("job is past cancelling");
      expect(
        (await client.experimental.tasks.getTask(task.taskId)).status,
      ).toBe("working");
    });

    test("a terminal task cannot be cancelled", async () => {
      const task = await startTask(client, "test-task-durable", {
        jobId: "job-7",
      });
      jobs.get("job-7")!.state = { status: "completed" };
      await client.experimental.tasks.getTask(task.taskId);
      const error = await mcpErrorOf(
        client.experimental.tasks.cancelTask(task.taskId),
      );
      expect(error.message).toContain("terminal status");
      expect(jobs.get("job-7")!.cancelCalls).toBe(0);
    });
  });

  describe("ownership", () => {
    let task: Task;

    beforeAll(async () => {
      task = await startTask(client, "test-task-durable", { jobId: "owned" });
    });

    test("the owner sees the task from a new session", async () => {
      const again = await session(token);
      expect((await again.experimental.tasks.getTask(task.taskId)).taskId).toBe(
        task.taskId,
      );
      const listed = await again.experimental.tasks.listTasks();
      expect(listed.tasks.map((t) => t.taskId)).toContain(task.taskId);
    });

    for (const [who, mint] of [
      ["another user", () => mintToken(freshUserId())],
      [
        "the same user on another OAuth client",
        () => mintToken(ownerId, "other"),
      ],
    ] as const) {
      test(`${who} gets exactly what an unknown id gets`, async () => {
        const stranger = await session(await mint());
        const unknownId = crypto.randomUUID();
        const get = async (id: string) =>
          (await mcpErrorOf(stranger.experimental.tasks.getTask(id))).message;
        const result = async (id: string) =>
          (await mcpErrorOf(taskResult(stranger, id))).message;
        const cancel = async (id: string) =>
          (await mcpErrorOf(stranger.experimental.tasks.cancelTask(id)))
            .message;

        expect(await get(task.taskId)).toBe(await get(unknownId));
        expect((await result(task.taskId)).replace(task.taskId, "<id>")).toBe(
          (await result(unknownId)).replace(unknownId, "<id>"),
        );
        expect((await cancel(task.taskId)).replace(task.taskId, "<id>")).toBe(
          (await cancel(unknownId)).replace(unknownId, "<id>"),
        );
        expect((await stranger.experimental.tasks.listTasks()).tasks).toEqual(
          [],
        );
        expect(jobs.get("owned")!.cancelCalls).toBe(0);
      });
    }
  });

  describe("listing and expiry", () => {
    test("pages newest first, and every task appears exactly once", async () => {
      const lister = await session(await mintToken(freshUserId()));
      const total = MCP_TASK_LIST_PAGE_SIZE + 2;
      const created: string[] = [];
      for (let i = 0; i < total; i++) {
        created.push(
          (await startTask(lister, "test-task-durable", { jobId: `list-${i}` }))
            .taskId,
        );
        await Bun.sleep(2);
      }

      const first = await lister.experimental.tasks.listTasks();
      expect(first.tasks.length).toBe(MCP_TASK_LIST_PAGE_SIZE);
      expect(first.nextCursor).toBeDefined();
      const second = await lister.experimental.tasks.listTasks(
        first.nextCursor,
      );
      expect(second.nextCursor).toBeUndefined();

      const listed = [...first.tasks, ...second.tasks].map((t) => t.taskId);
      expect(listed).toEqual([...created].reverse());
    });

    test("an expired task is gone everywhere, and pruned from the list", async () => {
      const owner = await session(await mintToken(freshUserId()));
      const kept = await startTask(owner, "test-task-durable", {
        jobId: "kept",
      });
      const lapsed = await startTask(owner, "test-task-durable", {
        jobId: "lapsed",
      });
      await api.redis.redis.del(mcpTaskKey(lapsed.taskId));

      const listed = await owner.experimental.tasks.listTasks();
      expect(listed.tasks.map((t) => t.taskId)).toEqual([kept.taskId]);
      await mcpErrorOf(owner.experimental.tasks.getTask(lapsed.taskId));
    });

    test("a requested ttl is honored up to the configured ceiling", async () => {
      const short = await startTask(
        client,
        "test-task-durable",
        { jobId: "ttl-1" },
        5000,
      );
      expect(short.ttl).toBe(5000);
      const pttl = await api.redis.redis.pttl(mcpTaskKey(short.taskId));
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(5000);

      const long = await startTask(
        client,
        "test-task-durable",
        { jobId: "ttl-2" },
        config.server.mcp.taskMaxTtl * 1000 * 10,
      );
      expect(long.ttl).toBe(config.server.mcp.taskMaxTtl * 1000);

      const unspecified = await startTask(client, "test-task-durable", {
        jobId: "ttl-3",
      });
      expect(unspecified.ttl).toBe(config.server.mcp.taskTtl * 1000);
    });
  });
});
