import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "path";
import { z } from "zod";
import { Action, api, Connection } from "../api";
import { CONNECTION_TYPE } from "../classes/Connection";
import type { TypedError } from "../classes/TypedError";
import { ErrorType } from "../classes/TypedError";
import { config } from "../config";
import { TransactionMiddleware } from "../middleware/transaction";
import { withTransaction } from "../util/transaction";
import { HOOK_TIMEOUT, useTestServer, waitFor } from "./setup";

/**
 * Boots the whole server with no Postgres and no Redis server: `REDIS_URL=memory://`
 * and an empty `DATABASE_URL`. Everything that normally lives in Redis (tasks, the
 * scheduler, PubSub, presence, fan-out) must keep working in-process.
 */

const original = {
  redis: config.redis.connectionString,
  database: config.database.connectionString,
  taskProcessors: config.tasks.taskProcessors,
  timeout: config.tasks.timeout,
  tasksEnabled: config.tasks.enabled,
};

// Must be registered before useTestServer() so it runs before api.start().
beforeAll(() => {
  config.redis.connectionString = "memory://";
  config.database.connectionString = "";
  config.tasks.taskProcessors = 1;
  config.tasks.timeout = 50;
  config.tasks.enabled = true;
});

const url = useTestServer({ clearDatabase: true, clearRedis: true });

afterAll(() => {
  config.redis.connectionString = original.redis;
  config.database.connectionString = original.database;
  config.tasks.taskProcessors = original.taskProcessors;
  config.tasks.timeout = original.timeout;
  config.tasks.enabled = original.tasksEnabled;
}, HOOK_TIMEOUT);

const ran: string[] = [];

class StandaloneTask implements Action {
  name = "standalone:task";
  inputs = z.object({ val: z.string() });
  task = { queue: "default" };
  run = async (params: { val: string }) => {
    ran.push(params.val);
    return { echoed: params.val };
  };
}

let recurringRuns = 0;
class StandaloneRecurring implements Action {
  name = "standalone:recurring";
  inputs = z.object({});
  task = { queue: "default", frequency: 100 };
  run = async () => {
    recurringRuns++;
  };
}

function registerAction(action: Action) {
  api.actions.actions.push(action);
  const job = api.resque.wrapActionAsJob(action);
  api.resque.jobs[action.name] = job;
  // Workers copy the job map when they are created, so teach the running ones too.
  for (const worker of api.resque.workers) worker.jobs[action.name] = job;
}

describe("standalone mode (no postgres, no redis server)", () => {
  test("reports which backends are active", () => {
    expect(api.redis.inMemory).toBe(true);
    expect(api.db.enabled).toBe(false);
    expect(api.db.db).toBeUndefined();
    expect(api.db.pool).toBeUndefined();
  });

  test("status is healthy with the database check disabled", async () => {
    const res = await fetch(`${url()}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      healthy: boolean;
      checks: Record<string, boolean | null>;
    };
    expect(body.healthy).toBe(true);
    expect(body.checks).toEqual({ database: null, redis: true });
  });

  test("database helpers fail with a clear error", async () => {
    const err = (await withTransaction(async () => 1).catch(
      (e) => e,
    )) as TypedError;
    expect(err.type).toBe(ErrorType.SERVER_INITIALIZATION);
    expect(err.message).toContain("database is disabled");

    const connection = new Connection(CONNECTION_TYPE.WEB, "standalone-tx");
    await expect(
      TransactionMiddleware.runBefore!({}, connection),
    ).rejects.toThrow("database is disabled");
    connection.destroy();
  });

  test("clearDatabase is a no-op", async () => {
    await api.db.clearDatabase();
  });

  test("basic commands, TTLs and pipelines work", async () => {
    await api.redis.redis.set("standalone:key", "value", "EX", 60);
    expect(await api.redis.redis.get("standalone:key")).toBe("value");
    expect(await api.redis.redis.ttl("standalone:key")).toBeGreaterThan(0);

    const results = await api.redis.redis
      .pipeline()
      .incr("standalone:counter")
      .expire("standalone:counter", 60)
      .get("standalone:counter")
      .exec();
    expect(results?.[2]?.[1]).toBe("1");
  });

  test("pubsub messages reach the subscription client", async () => {
    const received: string[] = [];
    const listener = (_channel: string, message: string) => {
      received.push(message);
    };
    api.redis.subscription.on("message", listener);
    try {
      await api.pubsub.broadcast("standalone", "hello", "test");
      await waitFor(() => received.some((m) => m.includes("hello")));
    } finally {
      api.redis.subscription.off("message", listener);
    }
  });

  test("presence lua scripts run", async () => {
    const connection = new Connection(
      CONNECTION_TYPE.WEB,
      "standalone-presence",
    );
    await api.channels.addPresence("standalone-room", connection);
    expect(await api.channels.members("standalone-room")).toEqual([
      connection.id,
    ]);

    // refresh-presence.lua loops over a variable number of keys
    const refreshLua = await Bun.file(
      path.join(import.meta.dir, "..", "lua", "refresh-presence.lua"),
    ).text();
    await api.redis.redis.eval(
      refreshLua,
      2,
      "presence:standalone-room",
      `presence:standalone-room:${connection.id}`,
      30,
    );
    expect(
      await api.redis.redis.ttl(`presence:standalone-room:${connection.id}`),
    ).toBeGreaterThan(0);

    await api.channels.removePresence("standalone-room", connection);
    expect(await api.channels.members("standalone-room")).toEqual([]);
    connection.destroy();
  });

  test("enqueued tasks are run by a worker", async () => {
    registerAction(new StandaloneTask());
    await api.actions.enqueue("standalone:task", { val: "from-queue" });
    await waitFor(() => ran.includes("from-queue"));
  });

  test("fan-out collects results", async () => {
    const { fanOutId } = await api.actions.fanOut("standalone:task", [
      { val: "fan-1" },
      { val: "fan-2" },
    ]);
    await waitFor(
      async () => (await api.actions.fanOutStatus(fanOutId)).completed === 2,
    );
    const status = await api.actions.fanOutStatus(fanOutId);
    expect(status.results).toHaveLength(2);
    expect(status.errors).toHaveLength(0);
  });

  test("recurring tasks keep firing", async () => {
    const action = new StandaloneRecurring();
    registerAction(action);
    await api.actions.enqueueRecurrent(action);
    await waitFor(() => recurringRuns >= 2, { timeout: 10_000 });
  });
});
