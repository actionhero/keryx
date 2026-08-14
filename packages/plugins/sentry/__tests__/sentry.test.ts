import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Action,
  api,
  type Connection,
  config,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import { sentryPlugin } from "..";
import { HOOK_TIMEOUT, serverUrl } from "./setup";

const DUMMY_DSN = "https://public@127.0.0.1/1";

type CapturedSpan = {
  name: string;
  op?: string;
  data: Record<string, unknown>;
  traceId?: string;
  parentSpanId?: string;
};

function spanName(span: Record<string, unknown>): string {
  return String(span.description ?? span.name ?? "");
}

function asSpan(span: Record<string, unknown>): CapturedSpan {
  const data =
    span.data && typeof span.data === "object"
      ? (span.data as Record<string, unknown>)
      : {};
  return {
    name: spanName(span),
    op: typeof span.op === "string" ? span.op : undefined,
    data,
    traceId: typeof span.trace_id === "string" ? span.trace_id : undefined,
    parentSpanId:
      typeof span.parent_span_id === "string" ? span.parent_span_id : undefined,
  };
}

class SentryBoom implements Action {
  name = "sentry:boom";
  description = "Throws a 500 for Sentry capture tests";
  inputs = z.object({});
  web = { route: "/sentry-boom", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  async run() {
    throw new TypedError({
      message: "intentional sentry test failure",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
}

class SentryEnqueue implements Action {
  name = "sentry:enqueue";
  description = "Enqueues status as a background task";
  inputs = z.object({});
  web = { route: "/sentry-enqueue", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  async run() {
    await api.actions.enqueue("status");
    return { enqueued: true };
  }
}

class SentryNest implements Action {
  name = "sentry:nest";
  description = "Calls status via connection.act()";
  inputs = z.object({});
  web = { route: "/sentry-nest", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  async run(_params: Record<string, unknown>, connection?: Connection) {
    const { error } = await connection!.act("status", {});
    if (error) throw error;
    return { nested: true };
  }
}

async function performJob(
  actionName: string,
  params: Record<string, unknown> = {},
) {
  const job = api.resque.jobs[actionName];
  if (!job) throw new Error(`No resque job registered for ${actionName}`);
  return job.perform.call({ queue: "default" }, params);
}

describe("sentry plugin (disabled)", () => {
  beforeAll(async () => {
    config.plugins = [sentryPlugin];
    await api.initialize();
    await api.start();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await api.stop();
    config.plugins = [];
  }, HOOK_TIMEOUT);

  test("api.sentry namespace exists with no-op defaults", () => {
    expect(api.sentry).toBeDefined();
    expect(api.sentry.enabled).toBe(false);
  });

  test("no-op captureException does not throw", () => {
    expect(api.sentry.captureException(new Error("nope"))).toBeUndefined();
  });

  test("no-op captureMessage does not throw", () => {
    expect(api.sentry.captureMessage("hello")).toBeUndefined();
  });

  test("no-op setUser / setTag / flush do not throw", async () => {
    expect(() => api.sentry.setUser({ id: "1" })).not.toThrow();
    expect(() => api.sentry.setTag("k", "v")).not.toThrow();
    expect(await api.sentry.flush(100)).toBe(true);
  });
});

describe("sentry plugin (enabled)", () => {
  const events: Array<Record<string, unknown>> = [];
  const spans: CapturedSpan[] = [];

  beforeAll(async () => {
    config.plugins = [sentryPlugin];
    await api.initialize();
    config.sentry.enabled = true;
    config.sentry.dsn = DUMMY_DSN;
    config.sentry.tracesSampleRate = 1;
    config.sentry.captureClientErrors = false;
    config.sentry.transport = () => ({
      send: async () => ({ statusCode: 200 }),
      flush: async () => true,
    });
    config.sentry.beforeSend = (event) => {
      events.push(event as unknown as Record<string, unknown>);
      return null;
    };
    config.sentry.beforeSendSpan = (span) => {
      spans.push(asSpan(span as unknown as Record<string, unknown>));
      return span;
    };
    await api.start();
    const boom = new SentryBoom();
    api.actions.actions.push(boom);
    api.resque.jobs[boom.name] = api.resque.wrapActionAsJob(boom);
    api.actions.actions.push(new SentryEnqueue());
    const nest = new SentryNest();
    api.actions.actions.push(nest);
    api.resque.jobs[nest.name] = api.resque.wrapActionAsJob(nest);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    api.actions.actions = api.actions.actions.filter(
      (a: Action) =>
        a.name !== "sentry:boom" &&
        a.name !== "sentry:enqueue" &&
        a.name !== "sentry:nest",
    );
    delete api.resque.jobs["sentry:boom"];
    delete api.resque.jobs["sentry:nest"];
    await api.stop();
    config.plugins = [];
  }, HOOK_TIMEOUT);

  beforeAll(() => {
    events.length = 0;
    spans.length = 0;
  });

  test("api.sentry is enabled after start", () => {
    expect(api.sentry.enabled).toBe(true);
  });

  test("HTTP request creates a transport span and an action span", async () => {
    spans.length = 0;
    const res = await fetch(`${serverUrl()}/api/status`);
    expect(res.status).toBe(200);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const httpSpan = spans.find(
      (s) => s.op === "http.server" || s.name.startsWith("GET"),
    );
    const actionSpan = spans.find((s) => s.name === "action:status");
    expect(httpSpan).toBeDefined();
    expect(actionSpan).toBeDefined();
    expect(actionSpan!.data["keryx.action"]).toBe("status");
    expect(actionSpan!.data["keryx.connection.type"]).toBe("web");
  });

  test("Redis commands create db spans", async () => {
    spans.length = 0;
    const res = await fetch(`${serverUrl()}/api/status`);
    expect(res.status).toBe(200);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const redisSpans = spans.filter((s) => s.name.startsWith("redis."));
    expect(redisSpans.length).toBeGreaterThan(0);
    for (const span of redisSpans) {
      expect(span.data["db.system"]).toBe("redis");
      expect(span.data["db.operation.name"]).toBeDefined();
    }
    const ping = redisSpans.find((s) => s.name === "redis.ping");
    expect(ping).toBeDefined();
    expect(ping!.data["db.query.text"]).toBe("ping");
  });

  test("Postgres commands create db spans", async () => {
    spans.length = 0;
    const res = await fetch(`${serverUrl()}/api/status`);
    expect(res.status).toBe(200);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const pgSpans = spans.filter((s) => s.name.startsWith("pg."));
    expect(pgSpans.length).toBeGreaterThan(0);
    for (const span of pgSpans) {
      expect(span.data["db.system"]).toBe("postgresql");
      expect(typeof span.data["db.query.text"]).toBe("string");
    }
  });

  test("WebSocket connect / message / action create transport spans", async () => {
    spans.length = 0;
    const wsUrl = serverUrl().replace(/^http/, "ws");
    const socket = new WebSocket(wsUrl);
    const messages: string[] = [];
    socket.addEventListener("message", (ev) => messages.push(String(ev.data)));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () =>
        reject(new Error("websocket error")),
      );
    });

    socket.send(
      JSON.stringify({
        messageType: "action",
        action: "status",
        messageId: 1,
        params: {},
      }),
    );
    const start = Date.now();
    while (messages.length === 0 && Date.now() - start < 5000) {
      await Bun.sleep(20);
    }
    socket.close();
    await Bun.sleep(50);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    expect(spans.some((s) => s.name === "ws.connect")).toBe(true);
    expect(spans.some((s) => s.name.startsWith("ws.message"))).toBe(true);
    expect(
      spans.some(
        (s) =>
          s.name === "action:status" &&
          s.data["keryx.connection.type"] === "websocket",
      ),
    ).toBe(true);
  });

  test("MCP connect / message / disconnect hooks emit transport spans", async () => {
    spans.length = 0;
    for (const hook of api.hooks.mcp.onConnectHooks) {
      await hook("sentry-test-session");
    }
    for (const hook of api.hooks.mcp.onMessageHooks) {
      await hook("sentry-test-session");
    }
    for (const hook of api.hooks.mcp.onDisconnectHooks) {
      await hook("sentry-test-session");
    }
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    expect(spans.some((s) => s.name === "mcp.connect")).toBe(true);
    expect(spans.some((s) => s.name === "mcp.message")).toBe(true);
  });

  test("5xx action failures are captured as Sentry events", async () => {
    events.length = 0;
    const res = await fetch(`${serverUrl()}/api/sentry-boom`);
    expect(res.status).toBe(500);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    expect(events.length).toBeGreaterThan(0);
    const messages = events.map((e) => {
      const exc = e.exception as
        | { values?: Array<{ value?: string }> }
        | undefined;
      return exc?.values?.[0]?.value ?? String(e.message ?? "");
    });
    expect(
      messages.some((m) => m.includes("intentional sentry test failure")),
    ).toBe(true);
  });

  test("4xx action failures are not captured by default", async () => {
    events.length = 0;
    const res = await fetch(`${serverUrl()}/api/does-not-exist`);
    expect(res.status).toBe(404);
    await api.sentry.flush(2000);
    await Bun.sleep(50);
    expect(events.length).toBe(0);
  });

  test("captureMessage records an event", async () => {
    events.length = 0;
    api.sentry.captureMessage("sentry plugin smoke");
    await api.sentry.flush(2000);
    await Bun.sleep(50);
    expect(events.length).toBeGreaterThan(0);
  });

  test("background tasks create a root queue.process span and a child action span", async () => {
    spans.length = 0;
    await performJob("status");
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const taskSpan = spans.find((s) => s.name === "task:status");
    const actionSpan = spans.find(
      (s) =>
        s.name === "action:status" &&
        s.data["keryx.connection.type"] === "task",
    );
    expect(taskSpan).toBeDefined();
    expect(taskSpan!.op).toBe("queue.process");
    expect(taskSpan!.data["keryx.action"]).toBe("status");
    expect(taskSpan!.data["keryx.connection.type"]).toBe("task");
    expect(taskSpan!.data["messaging.destination.name"]).toBe("default");
    expect(actionSpan).toBeDefined();
    expect(actionSpan!.op).toBe("keryx.action");
    expect(actionSpan!.parentSpanId).toBeDefined();
    expect(actionSpan!.traceId).toBe(taskSpan!.traceId);
  });

  test("enqueued tasks continue the originating HTTP trace", async () => {
    spans.length = 0;
    await api.actions.delQueue("default");
    const res = await fetch(`${serverUrl()}/api/sentry-enqueue`);
    expect(res.status).toBe(200);

    const queued = await api.actions.queued();
    const statusJob = queued.find((j) => j.class === "status");
    expect(statusJob).toBeDefined();
    const payload = statusJob!.args[0] as Record<string, unknown>;
    expect(typeof payload._sentryTrace).toBe("string");

    await performJob("status", payload);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const httpSpan = spans.find(
      (s) => s.op === "http.server" && s.name.includes("sentry:enqueue"),
    );
    const taskSpan = spans.find((s) => s.name === "task:status");
    expect(httpSpan).toBeDefined();
    expect(taskSpan).toBeDefined();
    expect(taskSpan!.traceId).toBe(httpSpan!.traceId);
  });

  test("nested connection.act() from HTTP stays on the same parent trace", async () => {
    spans.length = 0;
    const res = await fetch(`${serverUrl()}/api/sentry-nest`);
    expect(res.status).toBe(200);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const httpSpan = spans.find(
      (s) => s.op === "http.server" || s.name.includes("sentry:nest"),
    );
    const outer = spans.find((s) => s.name === "action:sentry:nest");
    const inner = spans.find(
      (s) =>
        s.name === "action:status" && s.data["keryx.connection.type"] === "web",
    );
    expect(httpSpan).toBeDefined();
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(outer!.traceId).toBe(httpSpan!.traceId);
    expect(inner!.traceId).toBe(httpSpan!.traceId);
    expect(spans.filter((s) => s.op === "queue.process")).toEqual([]);
  });

  test("nested connection.act() from a task stays on the task root trace", async () => {
    spans.length = 0;
    await performJob("sentry:nest");
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const taskRoots = spans.filter((s) => s.op === "queue.process");
    expect(taskRoots).toHaveLength(1);
    expect(taskRoots[0]!.name).toBe("task:sentry:nest");
    expect(spans.some((s) => s.name === "task:status")).toBe(false);

    const outer = spans.find((s) => s.name === "action:sentry:nest");
    const inner = spans.find(
      (s) =>
        s.name === "action:status" &&
        s.data["keryx.connection.type"] === "task",
    );
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(outer!.traceId).toBe(taskRoots[0]!.traceId);
    expect(inner!.traceId).toBe(taskRoots[0]!.traceId);
  });

  test("failed background tasks mark the root span as error and capture the exception", async () => {
    spans.length = 0;
    events.length = 0;
    await expect(performJob("sentry:boom")).rejects.toThrow(
      "intentional sentry test failure",
    );
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const taskSpan = spans.find((s) => s.name === "task:sentry:boom");
    expect(taskSpan).toBeDefined();
    expect(taskSpan!.op).toBe("queue.process");
    expect(events.length).toBeGreaterThan(0);
  });
});
