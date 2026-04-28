import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { api, Connection, logger } from "../../api";
import { Action, type ActionMiddleware } from "../../classes/Action";
import { LogFormat, LogLevel } from "../../classes/Logger";
import { ErrorType, TypedError } from "../../classes/TypedError";
import { config } from "../../config";
import { useTestServer } from "./../setup";

class SlowAction extends Action {
  constructor(timeout?: number) {
    super({
      name: "test:slow",
      description: "A test action that sleeps",
      inputs: z.object({ sleepMs: z.coerce.number() }),
      timeout,
    });
  }

  async run(
    params: { sleepMs: number },
    _connection?: unknown,
    abortSignal?: AbortSignal,
  ) {
    const start = Date.now();
    while (Date.now() - start < params.sleepMs) {
      if (abortSignal?.aborted) throw new Error("Aborted");
      await Bun.sleep(Math.min(10, params.sleepMs - (Date.now() - start)));
    }
    return { slept: params.sleepMs };
  }
}

useTestServer({ clearDatabase: true, clearRedis: true });

describe("Connection class", () => {
  test("constructor creates connection with unique ID", () => {
    const conn1 = new Connection("test", "identifier-1");
    const conn2 = new Connection("test", "identifier-2");

    expect(conn1.id).toBeDefined();
    expect(conn2.id).toBeDefined();
    expect(conn1.id).not.toBe(conn2.id);
  });

  test("constructor accepts custom ID", () => {
    const customId = "custom-test-id";
    const conn = new Connection("test", "identifier", customId);

    expect(conn.id).toBe(customId);
  });

  test("constructor sets type and identifier", () => {
    const conn = new Connection("websocket", "ws-client-123");

    expect(conn.type).toBe("websocket");
    expect(conn.identifier).toBe("ws-client-123");
  });

  test("connection is added to api.connections map", () => {
    const initialCount = api.connections.connections.size;
    const conn = new Connection("test", "test-added");

    expect(api.connections.connections.size).toBe(initialCount + 1);
    expect(api.connections.connections.get(conn.id)).toBe(conn);
  });

  test("subscriptions set is initialized empty", () => {
    const conn = new Connection("test", "test-subs");

    expect(conn.subscriptions).toBeDefined();
    expect(conn.subscriptions instanceof Set).toBe(true);
    expect(conn.subscriptions.size).toBe(0);
  });

  test("sessionLoaded flag starts as false", () => {
    const conn = new Connection("test", "test-session-flag");

    expect(conn.sessionLoaded).toBe(false);
  });

  test("rawConnection can be provided", () => {
    const rawConn = { socket: "test-socket" };
    const conn = new Connection("test", "test-raw", undefined, rawConn);

    expect(conn.rawConnection).toBe(rawConn);
  });

  test("sessionId defaults to id when not provided", () => {
    const conn = new Connection("test", "test-session-default");
    expect(conn.sessionId).toBe(conn.id);
  });

  test("sessionId defaults to custom id when not provided", () => {
    const conn = new Connection("test", "test-session-custom-id", "my-id");
    expect(conn.id).toBe("my-id");
    expect(conn.sessionId).toBe("my-id");
  });

  test("sessionId can differ from id", () => {
    const conn = new Connection(
      "websocket",
      "test-ws",
      "connection-uuid",
      undefined,
      "session-cookie-value",
    );
    expect(conn.id).toBe("connection-uuid");
    expect(conn.sessionId).toBe("session-cookie-value");
  });

  test("connections with different ids but same sessionId share a session", async () => {
    const sessionCookie = "shared-session-cookie";

    // Simulate a WebSocket connection with unique id but shared sessionId
    const wsConn = new Connection(
      "websocket",
      "127.0.0.1",
      "ws-unique-id",
      undefined,
      sessionCookie,
    );

    // Create a session via the WebSocket connection
    await api.session.create(wsConn, { userId: 42 });

    // Simulate an HTTP connection with a different unique id but same sessionId
    const httpConn = new Connection(
      "web",
      "127.0.0.1",
      sessionCookie,
      undefined,
    );

    // HTTP connection should find the same session
    const session = await api.session.load(httpConn);
    expect(session).toBeDefined();
    expect(session?.data.userId).toBe(42);

    // Both connections should coexist in the map
    expect(api.connections.connections.get("ws-unique-id")).toBe(wsConn);
    expect(api.connections.connections.get(sessionCookie)).toBe(httpConn);

    // Destroying the HTTP connection should not remove the WebSocket connection
    httpConn.destroy();
    expect(api.connections.connections.get("ws-unique-id")).toBe(wsConn);
    expect(api.connections.connections.get(sessionCookie)).toBeUndefined();
  });

  test("act executes status action successfully", async () => {
    const conn = new Connection("test", "test-act-status");

    const { response, error } = await conn.act("status", {});

    expect(error).toBeUndefined();
    expect(response).toBeDefined();
    expect(response).toHaveProperty("name");
    expect(response).toHaveProperty("pid");
    expect(response).toHaveProperty("version");
  });

  test("act returns error for non-existent action", async () => {
    const conn = new Connection("test", "test-act-notfound");

    const { response: _response, error } = await conn.act(
      "nonexistent-action",
      {},
    );

    expect(error).toBeDefined();
    expect(error?.type).toBe(ErrorType.CONNECTION_ACTION_NOT_FOUND);
    expect(error?.message).toContain("Action not found");
  });

  test("act returns error for undefined action name", async () => {
    const conn = new Connection("test", "test-act-undefined");

    const { response: _response, error } = await conn.act(undefined, {});

    expect(error).toBeDefined();
    expect(error?.type).toBe(ErrorType.CONNECTION_ACTION_NOT_FOUND);
  });

  test("act handles action with invalid parameters", async () => {
    const conn = new Connection("test", "test-act-invalid-params");
    // user:create requires name, email, password - we're not providing them

    const { response: _response, error } = await conn.act("user:create", {});

    expect(error).toBeDefined();
    // Should be a validation error
    expect(error?.message).toBeDefined();
  });

  test("act logs the connection type (trigger source)", async () => {
    const logMessages: string[] = [];
    const originalInfo = logger.info;
    logger.info = (message: string) => {
      logMessages.push(message);
    };

    try {
      for (const type of ["web", "cli", "resque", "websocket"]) {
        logMessages.length = 0;
        const conn = new Connection(type, `test-${type}`);
        await conn.act("status", {});

        const actionLog = logMessages.find(
          (msg) => msg.includes("[ACTION:") && msg.includes("status"),
        );
        expect(actionLog).toBeDefined();
        expect(actionLog).toContain(`[ACTION:${type.toUpperCase()}:OK]`);
      }
    } finally {
      logger.info = originalInfo;
    }
  });

  test("act outputs structured JSON log in json format mode", async () => {
    const logMessages: string[] = [];
    const originalFormat = config.logger.format;
    const originalLoggerFormat = logger.format;
    const originalLevel = logger.level;
    const origOutputStream = logger.outputStream;
    config.logger.format = LogFormat.json;
    logger.format = LogFormat.json;
    logger.level = LogLevel.trace;
    logger.outputStream = (...args: any[]) => {
      logMessages.push(args.join(" "));
    };

    try {
      const conn = new Connection("web", "test-json-log");
      await conn.act("status", {});

      const actionLog = logMessages.find((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.action === "status";
        } catch {
          return false;
        }
      });
      expect(actionLog).toBeDefined();

      const parsed = JSON.parse(actionLog!);
      expect(parsed.level).toBe("info");
      expect(parsed.action).toBe("status");
      expect(parsed.connectionType).toBe("web");
      expect(parsed.status).toBe("OK");
      expect(typeof parsed.duration).toBe("number");
      expect(parsed.pid).toBe(process.pid);
    } finally {
      config.logger.format = originalFormat;
      logger.format = originalLoggerFormat;
      logger.level = originalLevel;
      logger.outputStream = origOutputStream;
    }
  });

  test("act loads session for connection", async () => {
    const conn = new Connection("test", "test-session-load");

    // Create a session
    await api.session.create(conn, { userId: 999 });

    // Act should load the session
    await conn.act("status", {});

    // Session should be loaded
    expect(conn.session).toBeDefined();
    expect(conn.session?.data.userId).toBe(999);
  });

  test("subscribe adds room to subscriptions", () => {
    const conn = new Connection("test", "test-subscribe");

    conn.subscribe("room1");
    conn.subscribe("room2");

    expect(conn.subscriptions.has("room1")).toBe(true);
    expect(conn.subscriptions.has("room2")).toBe(true);
    expect(conn.subscriptions.size).toBe(2);
  });

  test("unsubscribe removes room from subscriptions", () => {
    const conn = new Connection("test", "test-unsubscribe");

    conn.subscribe("room1");
    conn.subscribe("room2");
    conn.unsubscribe("room1");

    expect(conn.subscriptions.has("room1")).toBe(false);
    expect(conn.subscriptions.has("room2")).toBe(true);
    expect(conn.subscriptions.size).toBe(1);
  });

  test("unsubscribe handles non-existent room gracefully", () => {
    const conn = new Connection("test", "test-unsub-nonexistent");

    // Should not throw
    conn.unsubscribe("non-existent-room");

    expect(conn.subscriptions.size).toBe(0);
  });

  test("connection can subscribe to multiple rooms", () => {
    const conn = new Connection("test", "test-multi-subscribe");

    const rooms = ["room1", "room2", "room3", "room4", "room5"];
    rooms.forEach((room) => conn.subscribe(room));

    expect(conn.subscriptions.size).toBe(5);
    rooms.forEach((room) => {
      expect(conn.subscriptions.has(room)).toBe(true);
    });
  });

  test("subscribing to same room multiple times only adds once", () => {
    const conn = new Connection("test", "test-duplicate-subscribe");

    conn.subscribe("duplicate-room");
    conn.subscribe("duplicate-room");
    conn.subscribe("duplicate-room");

    expect(conn.subscriptions.size).toBe(1);
    expect(conn.subscriptions.has("duplicate-room")).toBe(true);
  });

  test("connection without session has no session property", () => {
    const conn = new Connection("test", "test-no-session");

    expect(conn.session).toBeUndefined();
  });
});

describe("Connection metadata", () => {
  test("metadata initializes as empty object", () => {
    const conn = new Connection("test", "test-meta-init");
    expect(conn.metadata).toEqual({});
  });

  test("metadata resets on each act() call", async () => {
    const conn = new Connection("test", "test-meta-reset");
    (conn.metadata as Record<string, unknown>).foo = "bar";

    await conn.act("status", {});

    expect(conn.metadata).toEqual({});
  });

  test("metadata persists within a single act() lifecycle (middleware to action)", async () => {
    const capturedValues: { before?: string; after?: string } = {};

    const metadataMiddleware: ActionMiddleware = {
      runBefore: async (_params, connection) => {
        (connection.metadata as Record<string, unknown>).testKey =
          "middleware-value";
      },
      runAfter: async (_params, connection) => {
        capturedValues.after = (connection.metadata as Record<string, unknown>)
          .testKey as string;
      },
    };

    class MetadataTestAction extends Action {
      constructor() {
        super({
          name: "test:metadata",
          description: "Tests metadata flow",
          middleware: [metadataMiddleware],
        });
      }

      async run(_params: Record<string, unknown>, connection?: Connection) {
        capturedValues.before = (
          connection!.metadata as Record<string, unknown>
        ).testKey as string;
        return { ok: true };
      }
    }

    const testAction = new MetadataTestAction();
    api.actions.actions.push(testAction);

    try {
      const conn = new Connection("test", "test-meta-lifecycle");
      const { error } = await conn.act("test:metadata", {});

      expect(error).toBeUndefined();
      expect(capturedValues.before).toBe("middleware-value");
      expect(capturedValues.after).toBe("middleware-value");
    } finally {
      api.actions.actions = api.actions.actions.filter(
        (a: Action) => a.name !== "test:metadata",
      );
    }
  });

  test("runAfter middleware is called even when action throws", async () => {
    let runAfterCalled = false;

    const cleanupMiddleware: ActionMiddleware = {
      runAfter: async () => {
        runAfterCalled = true;
      },
    };

    class ThrowingAction extends Action {
      constructor() {
        super({
          name: "test:throwing",
          description: "An action that always throws",
          middleware: [cleanupMiddleware],
        });
      }

      async run() {
        throw new TypedError({
          message: "intentional failure",
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
    }

    const testAction = new ThrowingAction();
    api.actions.actions.push(testAction);

    try {
      const conn = new Connection("test", "test-runafter-on-throw");
      const { error } = await conn.act("test:throwing", {});

      expect(error).toBeDefined();
      expect(error!.message).toBe("intentional failure");
      expect(runAfterCalled).toBe(true);
    } finally {
      api.actions.actions = api.actions.actions.filter(
        (a: Action) => a.name !== "test:throwing",
      );
    }
  });

  test("metadata is typed via generic parameter", () => {
    type AppMeta = { membership: string; auditBefore: Record<string, unknown> };
    const conn = new Connection<Record<string, any>, AppMeta>(
      "test",
      "test-meta-typed",
    );

    conn.metadata.membership = "admin";
    conn.metadata.auditBefore = { name: "old" };

    expect(conn.metadata.membership).toBe("admin");
    expect(conn.metadata.auditBefore).toEqual({ name: "old" });
  });
});

describe("Action timeouts", () => {
  let originalTimeout: number;

  beforeAll(() => {
    originalTimeout = config.actions.timeout;
  });

  afterAll(() => {
    // restore original config and remove test action
    config.actions.timeout = originalTimeout;
    api.actions.actions = api.actions.actions.filter(
      (a: Action) => a.name !== "test:slow",
    );
  });

  test("action times out when exceeding global timeout", async () => {
    config.actions.timeout = 50;
    const slowAction = new SlowAction();
    api.actions.actions.push(slowAction);

    const conn = new Connection("test", "test-timeout");

    const { error } = await conn.act("test:slow", { sleepMs: "500" });

    expect(error).toBeDefined();
    expect(error?.type).toBe(ErrorType.CONNECTION_ACTION_TIMEOUT);
    expect(error?.message).toContain("timed out after 50ms");

    api.actions.actions = api.actions.actions.filter(
      (a: Action) => a.name !== "test:slow",
    );
  });

  test("per-action timeout overrides global timeout", async () => {
    config.actions.timeout = 10_000; // high global
    const slowAction = new SlowAction(50); // low per-action
    api.actions.actions.push(slowAction);

    const conn = new Connection("test", "test-per-action-timeout");

    const { error } = await conn.act("test:slow", { sleepMs: "500" });

    expect(error).toBeDefined();
    expect(error?.type).toBe(ErrorType.CONNECTION_ACTION_TIMEOUT);
    expect(error?.message).toContain("timed out after 50ms");

    api.actions.actions = api.actions.actions.filter(
      (a: Action) => a.name !== "test:slow",
    );
  });

  test("timeout of 0 disables the timeout", async () => {
    config.actions.timeout = 0;
    const slowAction = new SlowAction();
    api.actions.actions.push(slowAction);

    const conn = new Connection("test", "test-timeout-disabled");

    const { response, error } = await conn.act("test:slow", { sleepMs: "50" });

    expect(error).toBeUndefined();
    expect(response).toEqual({ slept: 50 });

    api.actions.actions = api.actions.actions.filter(
      (a: Action) => a.name !== "test:slow",
    );
  });

  test("fast action completes within timeout", async () => {
    config.actions.timeout = 5_000;
    const slowAction = new SlowAction();
    api.actions.actions.push(slowAction);

    const conn = new Connection("test", "test-fast-enough");

    const { response, error } = await conn.act("test:slow", { sleepMs: "10" });

    expect(error).toBeUndefined();
    expect(response).toEqual({ slept: 10 });

    api.actions.actions = api.actions.actions.filter(
      (a: Action) => a.name !== "test:slow",
    );
  });
});

describe("action lifecycle hooks (api.hooks.actions.beforeAct / afterAct)", () => {
  const resetHooks = () => {
    const hooksInitializer = api.initializers.find((i) => i.name === "hooks");
    (hooksInitializer as any).actionsBeforeAct.length = 0;
    (hooksInitializer as any).actionsAfterAct.length = 0;
  };

  class EchoAction extends Action {
    constructor() {
      super({
        name: "test:echo",
        description: "Echoes params back",
        inputs: z.object({ val: z.string() }),
      });
    }
    async run(params: { val: string }) {
      return { echoed: params.val };
    }
  }

  class ExplodeAction extends Action {
    constructor() {
      super({
        name: "test:explode",
        description: "Throws",
        inputs: z.object({}),
      });
    }
    async run(): Promise<unknown> {
      throw new Error("boom");
    }
  }

  beforeAll(() => {
    api.actions.actions.push(new EchoAction());
    api.actions.actions.push(new ExplodeAction());
  });

  afterAll(() => {
    api.actions.actions = api.actions.actions.filter(
      (a: Action) => a.name !== "test:echo" && a.name !== "test:explode",
    );
    resetHooks();
  });

  test("act preserves lifecycle ordering across the success path", async () => {
    resetHooks();
    const order: string[] = [];
    const originalInfo = logger.info;

    const lifecycleMiddleware: ActionMiddleware = {
      runBefore: async (params) => {
        order.push("middlewareBefore");
        expect(params.value).toBe(7);
        return { updatedParams: { value: 8 } };
      },
      runAfter: async (_params, _connection, error) => {
        order.push("middlewareAfter");
        expect(error).toBeUndefined();
        return { updatedResponse: { final: "middleware" } };
      },
    };

    class OrderedAction extends Action {
      constructor() {
        super({
          name: "test:lifecycle-order",
          description: "Records the action lifecycle ordering",
          inputs: z.object({
            value: z.coerce.number().transform((value) => {
              order.push("formatParams");
              return value;
            }),
          }),
          middleware: [lifecycleMiddleware],
        });
      }

      async run(params: { value: number }, connection: Connection) {
        order.push("actionRun");
        expect(params.value).toBe(8);
        expect(connection.session?.data.userId).toBe(123);
        return { final: "action" };
      }
    }

    api.hooks.actions.beforeAct((_name, params, connection) => {
      order.push("beforeAct");
      expect(params.value).toBe(7);
      expect(connection.session?.data.userId).toBe(123);
    });
    api.hooks.actions.afterAct((_name, _params, _conn, _ctx, outcome) => {
      order.push("afterAct");
      expect(outcome).toEqual({
        success: true,
        response: { final: "middleware" },
        duration: expect.any(Number),
      });
    });

    const action = new OrderedAction();
    api.actions.actions.push(action);

    const conn = new Connection("web", "test-lifecycle-order");
    const originalLoadSession = conn.loadSession.bind(conn);
    conn.loadSession = async () => {
      order.push("loadSession");
      return originalLoadSession();
    };
    await api.session.create(conn, { userId: 123 });

    logger.info = (...args: Parameters<typeof logger.info>) => {
      const message = args[0];
      const result = originalInfo.apply(logger, args);
      if (
        typeof message === "string" &&
        message.includes("[ACTION:WEB:OK]") &&
        message.includes("test:lifecycle-order")
      ) {
        order.push("log");
      }
      return result;
    };

    try {
      const { response, error } = await conn.act("test:lifecycle-order", {
        value: "7",
      });

      expect(error).toBeUndefined();
      expect(response).toEqual({ final: "middleware" });
      expect(order).toEqual([
        "loadSession",
        "formatParams",
        "beforeAct",
        "middlewareBefore",
        "actionRun",
        "middlewareAfter",
        "afterAct",
        "log",
      ]);
    } finally {
      logger.info = originalInfo;
      api.actions.actions = api.actions.actions.filter(
        (a: Action) => a.name !== "test:lifecycle-order",
      );
      resetHooks();
    }
  });

  test("middleware and afterAct receive success response and failure error", async () => {
    resetHooks();
    const seen: {
      successRunAfterError?: string;
      successAfterResponse?: unknown;
      failureRunAfterType?: ErrorType;
      failureAfterMessage?: string;
    } = {};

    const successMiddleware: ActionMiddleware = {
      runAfter: async (_params, _connection, error) => {
        seen.successRunAfterError = error?.message;
        return { updatedResponse: { ok: "middleware" } };
      },
    };
    const failureMiddleware: ActionMiddleware = {
      runAfter: async (_params, _connection, error) => {
        seen.failureRunAfterType = error?.type;
      },
    };

    class SuccessAction extends Action {
      constructor() {
        super({
          name: "test:lifecycle-success",
          middleware: [successMiddleware],
        });
      }

      async run(): Promise<unknown> {
        return { ok: "action" };
      }
    }

    class FailureAction extends Action {
      constructor() {
        super({
          name: "test:lifecycle-failure",
          middleware: [failureMiddleware],
        });
      }

      async run(): Promise<unknown> {
        throw new TypedError({
          message: "lifecycle failed",
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
    }

    api.hooks.actions.afterAct((actionName, _params, _conn, _ctx, outcome) => {
      if (actionName === "test:lifecycle-success" && outcome.success) {
        seen.successAfterResponse = outcome.response;
      }
      if (actionName === "test:lifecycle-failure" && !outcome.success) {
        seen.failureAfterMessage = (outcome.error as TypedError).message;
      }
    });

    api.actions.actions.push(new SuccessAction(), new FailureAction());

    try {
      const conn = new Connection("test", "test-lifecycle-outcomes");
      const success = await conn.act("test:lifecycle-success", {});
      const failure = await conn.act("test:lifecycle-failure", {});

      expect(success.error).toBeUndefined();
      expect(success.response).toEqual({ ok: "middleware" });
      expect(failure.error?.type).toBe(ErrorType.CONNECTION_ACTION_RUN);
      expect(failure.error?.message).toBe("lifecycle failed");
      expect(seen).toEqual({
        successAfterResponse: { ok: "middleware" },
        failureRunAfterType: ErrorType.CONNECTION_ACTION_RUN,
        failureAfterMessage: "lifecycle failed",
      });
    } finally {
      api.actions.actions = api.actions.actions.filter(
        (a: Action) =>
          a.name !== "test:lifecycle-success" &&
          a.name !== "test:lifecycle-failure",
      );
      resetHooks();
    }
  });

  test("after hooks receive before-middleware param updates when later before middleware throws", async () => {
    resetHooks();
    const seen: {
      runAfterParams?: unknown;
      afterActParams?: unknown;
      afterActError?: string;
    } = {};

    const middleware: ActionMiddleware[] = [
      {
        runBefore: async (params) => ({
          updatedParams: { ...params, enriched: true },
        }),
      },
      {
        runBefore: async () => {
          throw new TypedError({
            message: "blocked after enrichment",
            type: ErrorType.CONNECTION_ACTION_RUN,
          });
        },
      },
      {
        runAfter: async (params) => {
          seen.runAfterParams = params;
        },
      },
    ];

    class ThrowingBeforeMiddlewareAction extends Action {
      constructor() {
        super({
          name: "test:lifecycle-before-throw",
          inputs: z.object({ value: z.string() }),
          middleware,
        });
      }

      async run(): Promise<unknown> {
        return { ok: true };
      }
    }

    api.hooks.actions.afterAct((_name, params, _conn, _ctx, outcome) => {
      seen.afterActParams = params;
      seen.afterActError = outcome.success
        ? undefined
        : (outcome.error as TypedError).message;
    });

    api.actions.actions.push(new ThrowingBeforeMiddlewareAction());

    try {
      const conn = new Connection("test", "test-before-middleware-throws");
      const { error } = await conn.act("test:lifecycle-before-throw", {
        value: "original",
      });

      expect(error?.message).toBe("blocked after enrichment");
      expect(seen).toEqual({
        runAfterParams: { value: "original", enriched: true },
        afterActParams: { value: "original", enriched: true },
        afterActError: "blocked after enrichment",
      });
    } finally {
      api.actions.actions = api.actions.actions.filter(
        (a: Action) => a.name !== "test:lifecycle-before-throw",
      );
      resetHooks();
    }
  });

  test("beforeAct fires with connection, actionName, and params", async () => {
    resetHooks();
    const seen: Array<{
      actionName: string;
      params: any;
      type: string;
    }> = [];
    api.hooks.actions.beforeAct((actionName, params, connection) => {
      seen.push({ actionName, params, type: connection.type });
    });

    const conn = new Connection("cli", "hook-test-cli");
    await conn.act("test:echo", { val: "hi" });

    expect(seen).toEqual([
      { actionName: "test:echo", params: { val: "hi" }, type: "cli" },
    ]);
  });

  test("afterAct receives success outcome with response", async () => {
    resetHooks();
    const outcomes: Array<{
      success: boolean;
      response?: unknown;
      duration: number;
    }> = [];
    api.hooks.actions.afterAct((_name, _params, _conn, _ctx, outcome) => {
      outcomes.push({
        success: outcome.success,
        response: outcome.success ? outcome.response : undefined,
        duration: outcome.duration,
      });
    });

    const conn = new Connection("task", "hook-test-task");
    await conn.act("test:echo", { val: "ok" });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[0].response).toEqual({ echoed: "ok" });
    expect(outcomes[0].duration).toBeGreaterThanOrEqual(0);
  });

  test("afterAct receives failure outcome when action throws", async () => {
    resetHooks();
    const outcomes: Array<{ success: boolean; errorMessage?: string }> = [];
    api.hooks.actions.afterAct((_name, _params, _conn, _ctx, outcome) => {
      outcomes.push({
        success: outcome.success,
        errorMessage: outcome.success
          ? undefined
          : (outcome.error as { message?: string })?.message,
      });
    });

    const conn = new Connection("websocket", "hook-test-ws");
    await conn.act("test:explode", {});

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(false);
    expect(outcomes[0].errorMessage).toContain("boom");
  });

  test("ctx.metadata flows from beforeAct to afterAct", async () => {
    resetHooks();
    let carried: unknown;
    api.hooks.actions.beforeAct((_name, _params, _conn, ctx) => {
      ctx.metadata.marker = "threaded";
    });
    api.hooks.actions.afterAct((_name, _params, _conn, ctx) => {
      carried = ctx.metadata.marker;
    });

    const conn = new Connection("cli", "hook-test-ctx");
    await conn.act("test:echo", { val: "x" });

    expect(carried).toBe("threaded");
  });

  test("hooks do not fire when the action is not found", async () => {
    resetHooks();
    let fired = 0;
    api.hooks.actions.beforeAct(() => {
      fired++;
    });
    api.hooks.actions.afterAct(() => {
      fired++;
    });

    const conn = new Connection("cli", "hook-test-missing");
    const { error } = await conn.act("test:not-a-real-action", {});
    expect(error?.type).toBe(ErrorType.CONNECTION_ACTION_NOT_FOUND);
    expect(fired).toBe(0);
  });

  test("hooks do not fire when param validation fails", async () => {
    resetHooks();
    let fired = 0;
    api.hooks.actions.beforeAct(() => {
      fired++;
    });
    api.hooks.actions.afterAct(() => {
      fired++;
    });

    const conn = new Connection("cli", "hook-test-bad-params");
    const { error } = await conn.act("test:echo", {}); // missing required `val`
    expect(error).toBeDefined();
    expect(fired).toBe(0);
  });
});
