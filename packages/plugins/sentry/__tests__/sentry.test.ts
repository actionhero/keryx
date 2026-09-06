import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Action,
  api,
  CONNECTION_TYPE,
  Connection,
  config,
  ErrorType,
  HTTP_METHOD,
  LogLevel,
  logger,
  TypedError,
} from "keryx";
import { z } from "zod";
import { sentryPlugin } from "..";
import { instrumentLogger } from "../telemetry";
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

class SentryUserBoom implements Action {
  name = "sentry:user-boom";
  description = "Sets a user then throws a 500 for isolation tests";
  inputs = z.object({});
  web = { route: "/sentry-user-boom", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  async run() {
    api.sentry.setUser({ id: "user-42" });
    throw new TypedError({
      message: "user boom failure",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
}

class SentryEnqueue implements Action {
  name = "sentry:enqueue";
  description = "Enqueues sentry:traced as a background task";
  inputs = z.object({});
  web = { route: "/sentry-enqueue", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  async run() {
    await api.actions.enqueue("sentry:traced");
    return { enqueued: true };
  }
}

class SentryNest implements Action {
  name = "sentry:nest";
  description = "Calls sentry:traced via connection.act()";
  inputs = z.object({});
  web = { route: "/sentry-nest", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  async run(_params: Record<string, unknown>, connection?: Connection) {
    const { error } = await connection!.act("sentry:traced", {});
    if (error) throw error;
    return { nested: true };
  }
}

class SentryTraced implements Action {
  name = "sentry:traced";
  description = "Pings Redis and Postgres so span tests have a traced action";
  inputs = z.object({});
  web = { route: "/sentry-traced", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  async run() {
    if (api.redis?.redis) await api.redis.redis.ping();
    if (api.db?.pool) await api.db.pool.query("SELECT 1 AS one");
    return { ok: true };
  }
}

class SentryQuiet implements Action {
  name = "sentry:quiet";
  description = "Opts out of tracing";
  tracing = false;
  inputs = z.object({});
  web = { route: "/sentry-quiet", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  async run() {
    if (api.redis?.redis) await api.redis.redis.ping();
    return { ok: true };
  }
}

class SentryQuietBoom implements Action {
  name = "sentry:quiet-boom";
  description = "Opts out of tracing but still throws a 500";
  tracing = false;
  inputs = z.object({});
  web = { route: "/sentry-quiet-boom", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  async run() {
    throw new TypedError({
      message: "quiet boom failure",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
}

class SentryRecurring implements Action {
  name = "sentry:recurring";
  description =
    "Recurring task used to assert cron re-enqueue starts a new trace";
  inputs = z.object({});
  mcp = { tool: false };
  task = { frequency: 60_000, queue: "default" };
  async run() {
    return { ok: true };
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

function eventMessage(event: Record<string, unknown>): string {
  const exc = event.exception as
    | { values?: Array<{ value?: string }> }
    | undefined;
  return exc?.values?.[0]?.value ?? String(event.message ?? "");
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
  const logs: Array<{
    level: string;
    message: string;
    attributes: Record<string, unknown>;
  }> = [];
  const metrics: Array<{
    name: string;
    value: number;
    attributes: Record<string, unknown>;
  }> = [];

  beforeAll(async () => {
    config.plugins = [sentryPlugin];
    await api.initialize();
    config.sentry.enabled = true;
    config.sentry.dsn = DUMMY_DSN;
    config.sentry.tracesSampleRate = 1;
    config.sentry.captureClientErrors = false;
    config.sentry.enableLogs = true;
    config.sentry.enableMetrics = true;
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
    config.sentry.beforeSendLog = (log) => {
      logs.push({
        level: String(log.level),
        message: String(log.message),
        attributes: (log.attributes ?? {}) as Record<string, unknown>,
      });
      return log;
    };
    config.sentry.beforeSendMetric = (metric) => {
      metrics.push({
        name: metric.name,
        value: metric.value,
        attributes: (metric.attributes ?? {}) as Record<string, unknown>,
      });
      return metric;
    };
    await api.start();
    const boom = new SentryBoom();
    api.actions.actions.push(boom);
    api.resque.jobs[boom.name] = api.resque.wrapActionAsJob(boom);
    api.actions.actions.push(new SentryUserBoom());
    api.actions.actions.push(new SentryEnqueue());
    const nest = new SentryNest();
    api.actions.actions.push(nest);
    api.resque.jobs[nest.name] = api.resque.wrapActionAsJob(nest);
    const recurring = new SentryRecurring();
    api.actions.actions.push(recurring);
    api.resque.jobs[recurring.name] = api.resque.wrapActionAsJob(recurring);
    const traced = new SentryTraced();
    api.actions.actions.push(traced);
    api.resque.jobs[traced.name] = api.resque.wrapActionAsJob(traced);
    const quiet = new SentryQuiet();
    api.actions.actions.push(quiet);
    api.resque.jobs[quiet.name] = api.resque.wrapActionAsJob(quiet);
    const quietBoom = new SentryQuietBoom();
    api.actions.actions.push(quietBoom);
    api.resque.jobs[quietBoom.name] = api.resque.wrapActionAsJob(quietBoom);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    api.actions.actions = api.actions.actions.filter(
      (a: Action) =>
        a.name !== "sentry:boom" &&
        a.name !== "sentry:user-boom" &&
        a.name !== "sentry:enqueue" &&
        a.name !== "sentry:nest" &&
        a.name !== "sentry:recurring" &&
        a.name !== "sentry:traced" &&
        a.name !== "sentry:quiet" &&
        a.name !== "sentry:quiet-boom",
    );
    delete api.resque.jobs["sentry:boom"];
    delete api.resque.jobs["sentry:nest"];
    delete api.resque.jobs["sentry:recurring"];
    delete api.resque.jobs["sentry:traced"];
    delete api.resque.jobs["sentry:quiet"];
    delete api.resque.jobs["sentry:quiet-boom"];
    await api.stop();
    config.plugins = [];
  }, HOOK_TIMEOUT);

  beforeAll(() => {
    events.length = 0;
    spans.length = 0;
    logs.length = 0;
    metrics.length = 0;
  });

  test("api.sentry is enabled after start", () => {
    expect(api.sentry.enabled).toBe(true);
  });

  test("actions emit a per-action count metric grouped by name", async () => {
    metrics.length = 0;
    const res = await fetch(`${serverUrl()}/api/status`);
    expect(res.status).toBe(200);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const actionMetrics = metrics.filter(
      (m) => m.name === "keryx.action.count",
    );
    expect(actionMetrics.length).toBeGreaterThan(0);
    const statusMetric = actionMetrics.find(
      (m) => m.attributes["keryx.action"] === "status",
    );
    expect(statusMetric).toBeDefined();
    expect(statusMetric!.value).toBe(1);
    expect(statusMetric!.attributes["keryx.connection.type"]).toBe("web");
    expect(statusMetric!.attributes["keryx.action.success"]).toBe(true);
  });

  test("failed actions still emit a count metric marked unsuccessful", async () => {
    metrics.length = 0;
    const res = await fetch(`${serverUrl()}/api/sentry-boom`);
    expect(res.status).toBe(500);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const boomMetric = metrics.find(
      (m) =>
        m.name === "keryx.action.count" &&
        m.attributes["keryx.action"] === "sentry:boom",
    );
    expect(boomMetric).toBeDefined();
    expect(boomMetric!.attributes["keryx.action.success"]).toBe(false);
  });

  test("the application's real logs are forwarded to Sentry", async () => {
    logs.length = 0;
    const previousLevel = logger.level;
    logger.level = LogLevel.info;
    try {
      logger.warn("real app log to sentry", { requestId: "req-123", count: 7 });
      await api.sentry.flush(2000);
      await Bun.sleep(50);

      const forwarded = logs.find(
        (l) => l.message === "real app log to sentry",
      );
      expect(forwarded).toBeDefined();
      expect(forwarded!.level).toBe("warn");
      // The log's structured data is carried through as Sentry attributes.
      expect(forwarded!.attributes.requestId).toBe("req-123");
      expect(forwarded!.attributes.count).toBe(7);
    } finally {
      logger.level = previousLevel;
    }
  });

  test("logs filtered by the logger's level are not forwarded", async () => {
    logs.length = 0;
    const previousLevel = logger.level;
    // Only error and above reach stdout, so an info log must not reach Sentry.
    logger.level = LogLevel.error;
    try {
      logger.info("below the threshold, should be dropped");
      await api.sentry.flush(2000);
      await Bun.sleep(50);

      expect(
        logs.some(
          (l) => l.message === "below the threshold, should be dropped",
        ),
      ).toBe(false);
    } finally {
      logger.level = previousLevel;
    }
  });

  test("logs and metrics are suppressed when their toggles are off", async () => {
    logs.length = 0;
    metrics.length = 0;
    const previousLevel = logger.level;
    logger.level = LogLevel.info;
    config.sentry.enableLogs = false;
    config.sentry.enableMetrics = false;
    try {
      logger.warn("should not reach sentry while logs are off");
      const res = await fetch(`${serverUrl()}/api/sentry-traced`);
      expect(res.status).toBe(200);
      await api.sentry.flush(2000);
      await Bun.sleep(50);

      expect(metrics.some((m) => m.name === "keryx.action.count")).toBe(false);
      expect(
        logs.some(
          (l) => l.message === "should not reach sentry while logs are off",
        ),
      ).toBe(false);
    } finally {
      config.sentry.enableLogs = true;
      config.sentry.enableMetrics = true;
      logger.level = previousLevel;
    }
  });

  test("HTTP request creates a transport span and an action span", async () => {
    spans.length = 0;
    const res = await fetch(`${serverUrl()}/api/sentry-traced`);
    expect(res.status).toBe(200);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const httpSpan = spans.find(
      (s) => s.op === "http.server" || s.name.startsWith("GET"),
    );
    const actionSpan = spans.find((s) => s.name === "action:sentry:traced");
    expect(httpSpan).toBeDefined();
    expect(actionSpan).toBeDefined();
    expect(actionSpan!.data["keryx.action"]).toBe("sentry:traced");
    expect(actionSpan!.data["keryx.connection.type"]).toBe("web");
  });

  test("actions with tracing = false emit no HTTP or action spans", async () => {
    await api.sentry.flush(2000);
    await Bun.sleep(50);
    const prior = new Set(spans);
    const res = await fetch(`${serverUrl()}/api/sentry-quiet`);
    expect(res.status).toBe(200);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const fresh = spans.filter((s) => !prior.has(s));
    expect(fresh.some((s) => s.op === "http.server")).toBe(false);
    expect(fresh.some((s) => s.name === "action:sentry:quiet")).toBe(false);
    expect(fresh.some((s) => s.name.startsWith("redis."))).toBe(false);
    expect(fresh.some((s) => s.name.startsWith("pg."))).toBe(false);
  });

  test("tracing = false still records the per-action count metric", async () => {
    metrics.length = 0;
    const res = await fetch(`${serverUrl()}/api/sentry-quiet`);
    expect(res.status).toBe(200);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const quietMetric = metrics.find(
      (m) =>
        m.name === "keryx.action.count" &&
        m.attributes["keryx.action"] === "sentry:quiet",
    );
    expect(quietMetric).toBeDefined();
  });

  test("tracing = false still captures 5xx exceptions", async () => {
    events.length = 0;
    spans.length = 0;
    const res = await fetch(`${serverUrl()}/api/sentry-quiet-boom`);
    expect(res.status).toBe(500);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    expect(spans.some((s) => s.name === "action:sentry:quiet-boom")).toBe(
      false,
    );
    const messages = events.map((e) => eventMessage(e));
    expect(messages.some((m) => m.includes("quiet boom failure"))).toBe(true);
  });

  test("opted-out background tasks emit no queue.process span", async () => {
    await api.sentry.flush(2000);
    spans.length = 0;
    await performJob("sentry:quiet");
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    expect(spans.some((s) => s.name === "task:sentry:quiet")).toBe(false);
    expect(spans.some((s) => s.name === "action:sentry:quiet")).toBe(false);
    expect(spans.some((s) => s.name === "redis.ping")).toBe(false);
  });

  test("tracing suppress does not leak to the next job on the worker", async () => {
    await api.sentry.flush(2000);
    spans.length = 0;

    const quietCtx = {
      queue: "default",
      metadata: {} as Record<string, unknown>,
    };
    const tracedCtx = {
      queue: "default",
      metadata: {} as Record<string, unknown>,
    };
    const quietOutcome = {
      success: true as const,
      result: null,
      duration: 1,
    };

    for (const hook of api.hooks.resque.beforeJobHooks) {
      await hook("sentry:quiet", {}, quietCtx);
    }
    for (const hook of api.hooks.resque.afterJobHooks) {
      await hook("sentry:quiet", {}, quietCtx, quietOutcome);
    }
    for (const hook of api.hooks.resque.beforeJobHooks) {
      await hook("sentry:traced", {}, tracedCtx);
    }

    await api.redis.redis.ping();

    for (const hook of api.hooks.resque.afterJobHooks) {
      await hook("sentry:traced", {}, tracedCtx, quietOutcome);
    }

    await api.sentry.flush(2000);
    await Bun.sleep(50);

    expect(quietCtx.metadata.sentryPrevSuppressed).toBe(false);
    expect(tracedCtx.metadata.sentrySpan).toBeDefined();
    expect(spans.some((s) => s.name === "redis.ping")).toBe(true);

    await api.sentry.flush(2000);
    spans.length = 0;
    await performJob("sentry:quiet");
    await performJob("sentry:traced");
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    expect(spans.some((s) => s.name === "task:sentry:traced")).toBe(true);
    expect(spans.some((s) => s.name === "redis.ping")).toBe(true);
  });

  test("Redis commands create db spans", async () => {
    spans.length = 0;
    const res = await fetch(`${serverUrl()}/api/sentry-traced`);
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
    const res = await fetch(`${serverUrl()}/api/sentry-traced`);
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
        action: "sentry:traced",
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
          s.name === "action:sentry:traced" &&
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

  test("Postgres queries are not double-instrumented", async () => {
    await api.sentry.flush(2000);
    await Bun.sleep(50);
    const prior = new Set(spans);
    const res1 = await fetch(`${serverUrl()}/api/sentry-traced`);
    const res2 = await fetch(`${serverUrl()}/api/sentry-traced`);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const selectSpans = spans.filter(
      (s) => !prior.has(s) && s.data["db.query.text"] === "SELECT 1 AS one",
    );
    // One span per query — no stacked pool.query + client.query duplicate.
    expect(selectSpans.length).toBe(2);
    for (const span of selectSpans) {
      expect(span.name).toBe("pg.SELECT");
      expect(span.data["db.system"]).toBe("postgresql");
    }
  });

  test("MCP message spans do not leak across overlapping messages", async () => {
    spans.length = 0;
    const sessionId = "sentry-leak-session";
    for (const hook of api.hooks.mcp.onConnectHooks) {
      await hook(sessionId);
    }
    // Two messages for the same session without an intervening afterAct: the
    // first must be ended when the second arrives instead of leaking.
    for (const hook of api.hooks.mcp.onMessageHooks) {
      await hook(sessionId);
    }
    for (const hook of api.hooks.mcp.onMessageHooks) {
      await hook(sessionId);
    }
    for (const hook of api.hooks.mcp.onDisconnectHooks) {
      await hook(sessionId);
    }
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const messageSpans = spans.filter((s) => s.name === "mcp.message");
    expect(messageSpans.length).toBe(2);
  });

  test("user identity is isolated per request", async () => {
    events.length = 0;
    // First request sets a user and fails; second fails without a user.
    const withUser = await fetch(`${serverUrl()}/api/sentry-user-boom`);
    expect(withUser.status).toBe(500);
    const withoutUser = await fetch(`${serverUrl()}/api/sentry-boom`);
    expect(withoutUser.status).toBe(500);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const userEvent = events.find((e) =>
      eventMessage(e).includes("user boom failure"),
    );
    const plainEvent = events.find((e) =>
      eventMessage(e).includes("intentional sentry test failure"),
    );
    expect(userEvent).toBeDefined();
    expect(plainEvent).toBeDefined();
    expect((userEvent?.user as { id?: string } | undefined)?.id).toBe(
      "user-42",
    );
    // The identity from the first request must not bleed onto the second.
    expect(plainEvent?.user).toBeUndefined();
  });

  test("nested actions preserve the outer request identity", async () => {
    events.length = 0;
    const connection = new Connection(CONNECTION_TYPE.CLI, "cli:nested-test");

    // Outer action establishes the request's identity.
    const outerCtx = { metadata: {} as Record<string, unknown> };
    for (const hook of api.hooks.actions.beforeActHooks) {
      await hook("outer", {}, connection, outerCtx);
    }
    api.sentry.setUser({ id: "outer-user" });

    // A nested action runs to completion without touching identity; it must
    // not reset the outer action's buffer.
    const innerCtx = { metadata: {} as Record<string, unknown> };
    for (const hook of api.hooks.actions.beforeActHooks) {
      await hook("inner", {}, connection, innerCtx);
    }
    for (const hook of api.hooks.actions.afterActHooks) {
      await hook("inner", {}, connection, innerCtx, {
        success: true,
        response: null,
        duration: 1,
      });
    }

    // The outer action's capture still sees the outer identity.
    api.sentry.captureException(new Error("nested identity capture"));
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const event = events.find((e) =>
      eventMessage(e).includes("nested identity capture"),
    );
    expect(event).toBeDefined();
    expect((event?.user as { id?: string } | undefined)?.id).toBe("outer-user");

    // Restore the outer action's buffer so this test leaves the shared async
    // context clean for the ones that follow.
    for (const hook of api.hooks.actions.afterActHooks) {
      await hook("outer", {}, connection, outerCtx, {
        success: true,
        response: null,
        duration: 1,
      });
    }
  });

  test("identity does not leak across sequential actions", async () => {
    events.length = 0;
    const connection = new Connection(CONNECTION_TYPE.WEBSOCKET, "ws:seq-test");

    // First action sets a user and completes.
    const ctx1 = { metadata: {} as Record<string, unknown> };
    for (const hook of api.hooks.actions.beforeActHooks) {
      await hook("first", {}, connection, ctx1);
    }
    api.sentry.setUser({ id: "first-user" });
    for (const hook of api.hooks.actions.afterActHooks) {
      await hook("first", {}, connection, ctx1, {
        success: true,
        response: null,
        duration: 1,
      });
    }

    // A later action on the same long-lived context must not inherit the first
    // action's identity buffer.
    const ctx2 = { metadata: {} as Record<string, unknown> };
    for (const hook of api.hooks.actions.beforeActHooks) {
      await hook("second", {}, connection, ctx2);
    }
    api.sentry.captureException(new Error("sequential identity capture"));
    for (const hook of api.hooks.actions.afterActHooks) {
      await hook("second", {}, connection, ctx2, {
        success: true,
        response: null,
        duration: 1,
      });
    }
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const event = events.find((e) =>
      eventMessage(e).includes("sequential identity capture"),
    );
    expect(event).toBeDefined();
    expect((event?.user as { id?: string } | undefined)?.id).not.toBe(
      "first-user",
    );
  });

  test("background task spans continue the enqueuer's trace", async () => {
    spans.length = 0;
    const traceId = "abcdef12345678901234567890abcdef";
    const parentSpanId = "1234567890abcdef";
    const sentryTrace = `${traceId}-${parentSpanId}-1`;
    const params: Record<string, unknown> = {
      _sentryTrace: sentryTrace,
      _sentryBaggage: "sentry-environment=test",
      foo: "bar",
    };
    const jobCtx = {
      queue: "default",
      metadata: {} as Record<string, unknown>,
    };

    for (const hook of api.hooks.resque.beforeJobHooks) {
      await hook("sentry:task", params, jobCtx);
    }
    // Propagation fields are stripped before the action sees params.
    expect(params._sentryTrace).toBeUndefined();
    expect(params._sentryBaggage).toBeUndefined();

    const connection = new Connection(CONNECTION_TYPE.TASK, "task:sentry:1");
    const actCtx = { metadata: {} as Record<string, unknown> };
    for (const hook of api.hooks.actions.beforeActHooks) {
      await hook("sentry:task", params, connection, actCtx);
    }
    for (const hook of api.hooks.actions.afterActHooks) {
      await hook("sentry:task", params, connection, actCtx, {
        success: true,
        response: null,
        duration: 1,
      });
    }
    for (const hook of api.hooks.resque.afterJobHooks) {
      await hook("sentry:task", params, jobCtx, {
        success: true,
        result: null,
        duration: 1,
      });
    }
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const rootSpan = spans.find((s) => s.name === "task:sentry:task");
    const actionSpan = spans.find((s) => s.name === "action:sentry:task");
    expect(rootSpan).toBeDefined();
    expect(actionSpan).toBeDefined();
    // Both join the enqueuer's trace rather than starting a fresh one.
    expect(rootSpan!.traceId).toBe(traceId);
    expect(actionSpan!.traceId).toBe(traceId);
  });

  test("background tasks create a root queue.process span and a child action span", async () => {
    spans.length = 0;
    await performJob("sentry:traced");
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const taskSpan = spans.find((s) => s.name === "task:sentry:traced");
    const actionSpan = spans.find(
      (s) =>
        s.name === "action:sentry:traced" &&
        s.data["keryx.connection.type"] === "task",
    );
    expect(taskSpan).toBeDefined();
    expect(taskSpan!.op).toBe("queue.process");
    expect(taskSpan!.data["keryx.action"]).toBe("sentry:traced");
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
    const tracedJob = queued.find((j) => j.class === "sentry:traced");
    expect(tracedJob).toBeDefined();
    const payload = tracedJob!.args[0] as Record<string, unknown>;
    expect(typeof payload._sentryTrace).toBe("string");

    await performJob("sentry:traced", payload);
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const httpSpan = spans.find(
      (s) => s.op === "http.server" && s.name.includes("sentry:enqueue"),
    );
    const taskSpan = spans.find((s) => s.name === "task:sentry:traced");
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
        s.name === "action:sentry:traced" &&
        s.data["keryx.connection.type"] === "web",
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
    expect(spans.some((s) => s.name === "task:sentry:traced")).toBe(false);

    const outer = spans.find((s) => s.name === "action:sentry:nest");
    const inner = spans.find(
      (s) =>
        s.name === "action:sentry:traced" &&
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

  test("recurring re-enqueue does not continue the finished job's trace", async () => {
    await performJob("sentry:recurring");
    const delayed = await api.actions.allDelayed();
    const jobs = Object.values(delayed).flat();
    const recurring = jobs.filter((j) => j.class === "sentry:recurring");
    expect(recurring.length).toBeGreaterThan(0);
    for (const job of recurring) {
      const payload = (job.args?.[0] ?? {}) as Record<string, unknown>;
      expect(payload._sentryTrace).toBeUndefined();
    }
  });
});

describe("sentry logger instrumentation", () => {
  test("wrapping is idempotent and the restorer unwraps cleanly", () => {
    const original = logger.log;
    const isWrapped = () =>
      (logger.log as { __sentryWrapped?: boolean }).__sentryWrapped === true;

    try {
      const restore = instrumentLogger();
      expect(typeof restore).toBe("function");
      expect(isWrapped()).toBe(true);

      // A second wrap must be a no-op that returns undefined — so a caller that
      // blindly assigns the result never clobbers the real restorer and loses
      // the ability to unwrap the singleton logger on stop().
      expect(instrumentLogger()).toBeUndefined();

      restore?.();
      expect(isWrapped()).toBe(false);

      // Unwrapped, so a later start() can wrap it again.
      const restoreAgain = instrumentLogger();
      expect(typeof restoreAgain).toBe("function");
      restoreAgain?.();
      expect(isWrapped()).toBe(false);
    } finally {
      logger.log = original;
    }
  });
});
