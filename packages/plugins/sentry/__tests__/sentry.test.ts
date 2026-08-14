import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Action,
  api,
  CONNECTION_TYPE,
  Connection,
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
    api.actions.actions.push(new SentryBoom());
    api.actions.actions.push(new SentryUserBoom());
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    api.actions.actions = api.actions.actions.filter(
      (a: Action) => a.name !== "sentry:boom" && a.name !== "sentry:user-boom",
    );
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

  test("Postgres queries are not double-instrumented", async () => {
    spans.length = 0;
    await api.db.pool.query("SELECT 1 AS one");
    await api.db.pool.query("SELECT 1 AS one");
    await api.sentry.flush(2000);
    await Bun.sleep(50);

    const selectSpans = spans.filter(
      (s) => s.data["db.query.text"] === "SELECT 1 AS one",
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
});
