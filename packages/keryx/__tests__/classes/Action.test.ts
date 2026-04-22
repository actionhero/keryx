import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  Action,
  DEFAULT_QUEUE,
  HTTP_METHOD,
  MCP_RESPONSE_FORMAT,
} from "../../classes/Action";

class MinimalAction extends Action {
  async run() {
    return { ok: true };
  }
}

class ConfiguredAction extends Action {
  async run() {
    return { ok: true };
  }
}

describe("Action constructor defaults", () => {
  test("minimal args set sensible defaults", () => {
    const action = new MinimalAction({ name: "minimal" });

    expect(action.name).toBe("minimal");
    expect(action.description).toBe("An Action: minimal");
    expect(action.inputs).toBeUndefined();
    expect(action.middleware).toEqual([]);
    expect(action.timeout).toBeUndefined();
  });

  test("web defaults to GET at /${name} with streaming off", () => {
    const action = new MinimalAction({ name: "status" });

    expect(action.web).toEqual({
      route: "/status",
      method: HTTP_METHOD.GET,
      streaming: false,
    });
  });

  test("task defaults to DEFAULT_QUEUE with no frequency", () => {
    const action = new MinimalAction({ name: "minimal" });

    expect(action.task).toEqual({
      frequency: undefined,
      queue: DEFAULT_QUEUE,
    });
  });

  test("mcp defaults tool: true when mcp config omitted", () => {
    const action = new MinimalAction({ name: "minimal" });

    expect(action.mcp).toEqual({ tool: true });
  });

  test("mcp merges tool: true default with user-provided fields", () => {
    const action = new ConfiguredAction({
      name: "status:resource",
      mcp: {
        resource: { uri: "keryx://status", mimeType: "application/json" },
      },
    });

    expect(action.mcp?.tool).toBe(true);
    expect(action.mcp?.resource).toEqual({
      uri: "keryx://status",
      mimeType: "application/json",
    });
  });

  test("mcp tool can be explicitly disabled", () => {
    const action = new ConfiguredAction({
      name: "greeting:prompt",
      mcp: { tool: false, prompt: { title: "Greeting" } },
    });

    expect(action.mcp?.tool).toBe(false);
    expect(action.mcp?.prompt?.title).toBe("Greeting");
  });
});

describe("Action constructor overrides", () => {
  test("custom description is preserved", () => {
    const action = new ConfiguredAction({
      name: "x",
      description: "Does the X thing",
    });

    expect(action.description).toBe("Does the X thing");
  });

  test("custom web route, method, and streaming are preserved", () => {
    const action = new ConfiguredAction({
      name: "stream:counter",
      web: {
        route: "/streaming/counter",
        method: HTTP_METHOD.POST,
        streaming: true,
      },
    });

    expect(action.web).toEqual({
      route: "/streaming/counter",
      method: HTTP_METHOD.POST,
      streaming: true,
    });
  });

  test("regex web routes are preserved", () => {
    const pattern = /^\/users\/(\d+)$/;
    const action = new ConfiguredAction({
      name: "user:view",
      web: { route: pattern, method: HTTP_METHOD.GET },
    });

    expect(action.web?.route).toBe(pattern);
  });

  test("custom task queue and frequency are preserved", () => {
    const action = new ConfiguredAction({
      name: "cleanup",
      task: { queue: "cleanup-queue", frequency: 60_000 },
    });

    expect(action.task?.queue).toBe("cleanup-queue");
    expect(action.task?.frequency).toBe(60_000);
  });

  test("task with only frequency falls back to DEFAULT_QUEUE", () => {
    const action = new ConfiguredAction({
      name: "cleanup",
      task: { frequency: 100 } as unknown as {
        queue: string;
        frequency: number;
      },
    });

    expect(action.task?.queue).toBe(DEFAULT_QUEUE);
    expect(action.task?.frequency).toBe(100);
  });

  test("middleware array is preserved by reference", () => {
    const mw = { runBefore: async () => undefined };
    const action = new ConfiguredAction({
      name: "x",
      middleware: [mw],
    });

    expect(action.middleware).toHaveLength(1);
    expect(action.middleware?.[0]).toBe(mw);
  });

  test("custom timeout is preserved, including 0 to disable", () => {
    const action = new ConfiguredAction({ name: "x", timeout: 0 });
    expect(action.timeout).toBe(0);
  });

  test("input zod schema is attached", () => {
    const schema = z.object({ count: z.number().int().min(1) });
    const action = new ConfiguredAction({ name: "x", inputs: schema });
    expect(action.inputs).toBe(schema);
  });

  test("mcp responseFormat override is retained", () => {
    const action = new ConfiguredAction({
      name: "status:markdown",
      mcp: { responseFormat: MCP_RESPONSE_FORMAT.MARKDOWN },
    });
    expect(action.mcp?.responseFormat).toBe(MCP_RESPONSE_FORMAT.MARKDOWN);
  });
});

describe("Action constants", () => {
  test("DEFAULT_QUEUE is 'default'", () => {
    expect(DEFAULT_QUEUE).toBe("default");
  });

  test("HTTP_METHOD enum covers expected verbs", () => {
    expect(HTTP_METHOD.GET as string).toBe("GET");
    expect(HTTP_METHOD.POST as string).toBe("POST");
    expect(HTTP_METHOD.PUT as string).toBe("PUT");
    expect(HTTP_METHOD.DELETE as string).toBe("DELETE");
    expect(HTTP_METHOD.PATCH as string).toBe("PATCH");
    expect(HTTP_METHOD.OPTIONS as string).toBe("OPTIONS");
  });

  test("MCP_RESPONSE_FORMAT values", () => {
    expect(MCP_RESPONSE_FORMAT.JSON as string).toBe("json");
    expect(MCP_RESPONSE_FORMAT.MARKDOWN as string).toBe("markdown");
  });
});

describe("Action.run contract", () => {
  test("run is invokable on a concrete subclass", async () => {
    const action = new MinimalAction({ name: "minimal" });
    // Minimal test that the abstract method is implemented; wider behavior
    // (middleware ordering, input validation, transport dispatch) is covered
    // by integration tests in __tests__/servers and __tests__/initializers.
    const out = await (
      action.run as (
        params: unknown,
        connection: unknown,
      ) => Promise<{ ok: boolean }>
    )({}, {});
    expect(out).toEqual({ ok: true });
  });
});
