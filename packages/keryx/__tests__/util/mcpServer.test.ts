import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { api } from "../../api";
import { Action, HTTP_METHOD } from "../../classes/Action";
import { Channel } from "../../classes/Channel";
import type { Connection } from "../../classes/Connection";
import { ErrorType, TypedError } from "../../classes/TypedError";
import { config } from "../../config";
import {
  isMcpSessionAuthorizedForChannel,
  MCP_JSONRPC_ERROR,
  validateJsonRpcPayload,
} from "../../util/mcpServer";
import { serverUrl, useTestServer } from "../setup";

const mcpUrl = () => `${serverUrl()}${config.server.mcp.route}`;

/**
 * Temporary test action that exposes an MCP resource via URI template.
 * Registered before tests and removed after.
 */
class TestTemplateResource extends Action {
  constructor() {
    super({
      name: "test:template-resource",
      description: "Test resource with URI template variables",
      inputs: z.object({
        name: z.string().describe("A name variable from the URI template"),
      }),
      mcp: {
        tool: false,
        resource: {
          uriTemplate: "keryx://test-greeting/{name}",
          mimeType: "text/plain",
        },
      },
      web: { route: "/test-template-resource/:name", method: HTTP_METHOD.GET },
    });
  }

  async run(params: { name: string }) {
    return { text: `Hello, ${params.name}!` };
  }
}

/**
 * Temporary test action that exposes an MCP prompt.
 * Registered before tests and removed after.
 */
class TestPrompt extends Action {
  constructor() {
    super({
      name: "test:prompt",
      description: "Test prompt with arguments",
      inputs: z.object({
        topic: z.string().optional().describe("Topic to discuss"),
      }),
      mcp: {
        tool: false,
        prompt: { title: "Test Prompt" },
      },
      web: { route: "/test-prompt", method: HTTP_METHOD.GET },
    });
  }

  async run(params: { topic?: string }) {
    return {
      description: "A test prompt",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Let's talk about ${params.topic ?? "anything"}.`,
          },
        },
      ],
    };
  }
}

describe("mcpServer utilities (integration)", () => {
  const testActions: Action[] = [];

  beforeAll(() => {
    config.server.mcp.enabled = true;
  });

  useTestServer();

  beforeAll(() => {
    // Inject test actions after start (api.actions is now populated).
    // MCP servers are created per-session, so these will be picked up
    // when the test client connects.
    const templateResource = new TestTemplateResource();
    const prompt = new TestPrompt();
    testActions.push(templateResource, prompt);
    api.actions.actions.push(...testActions);
  });

  afterAll(() => {
    config.server.mcp.enabled = false;

    // Remove injected test actions
    for (const action of testActions) {
      const idx = api.actions.actions.indexOf(action);
      if (idx !== -1) api.actions.actions.splice(idx, 1);
    }
  });

  describe("URI template resources", () => {
    // MCP requires auth — get a token via the OAuth initializer
    let accessToken: string;

    beforeAll(async () => {
      // Store a token directly in Redis to avoid the full OAuth flow
      accessToken = crypto.randomUUID();
      await api.redis.redis.set(
        `oauth:token:${accessToken}`,
        JSON.stringify({ userId: 0, clientId: "test", scopes: [] }),
        "EX",
        60,
      );
    });

    afterEach(async () => {
      // Clean up session keys created during tests
      const keys = await api.redis.redis.keys("session:*");
      if (keys.length > 0) await api.redis.redis.del(...keys);
    });

    test("listResourceTemplates includes URI template resource", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
        requestInit: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      });
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(transport);

      try {
        const result = await client.listResourceTemplates();
        const uris = result.resourceTemplates.map((r) => r.uriTemplate);
        expect(uris).toContain("keryx://test-greeting/{name}");
      } finally {
        try {
          await transport.close();
        } catch {
          // ignore
        }
      }
    });

    test("reading a URI template resource passes variables to the action", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
        requestInit: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      });
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(transport);

      try {
        const result = await client.readResource({
          uri: "keryx://test-greeting/World",
        });
        expect(result.contents).toBeArray();
        expect(result.contents.length).toBe(1);

        const content = result.contents[0];
        expect(content.uri).toBe("keryx://test-greeting/World");
        expect(content.mimeType).toBe("text/plain");
        expect((content as { text: string }).text).toBe("Hello, World!");
      } finally {
        try {
          await transport.close();
        } catch {
          // ignore
        }
      }
    });
  });

  describe("prompt registration", () => {
    let accessToken: string;

    beforeAll(async () => {
      accessToken = crypto.randomUUID();
      await api.redis.redis.set(
        `oauth:token:${accessToken}`,
        JSON.stringify({ userId: 0, clientId: "test", scopes: [] }),
        "EX",
        60,
      );
    });

    test("prompt with arguments returns expected messages", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
        requestInit: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      });
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(transport);

      try {
        const result = await client.getPrompt({
          name: "test-prompt",
          arguments: { topic: "refactoring" },
        });
        expect(result.messages).toBeArray();
        expect(result.messages.length).toBe(1);
        const msg = result.messages[0];
        expect(msg.role).toBe("user");
        expect((msg.content as { type: string; text: string }).text).toContain(
          "refactoring",
        );
      } finally {
        try {
          await transport.close();
        } catch {
          // ignore
        }
      }
    });
  });

  // JSON-RPC 2.0 reserves -32700 for input that isn't JSON at all and -32600
  // for JSON that isn't a valid message. Conflating the two (as the SDK
  // transport does) is flagged by MCP conformance checkers.
  describe("JSON-RPC request validation", () => {
    let accessToken: string;

    const jsonRpcHeaders = () => ({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    });

    /** POST a raw (possibly malformed) body and return the parsed error envelope. */
    async function postRaw(body: string, sessionId?: string) {
      const res = await fetch(mcpUrl(), {
        method: "POST",
        headers: sessionId
          ? { ...jsonRpcHeaders(), "mcp-session-id": sessionId }
          : jsonRpcHeaders(),
        body,
      });
      return {
        status: res.status,
        body: (await res.json()) as {
          jsonrpc?: string;
          id?: unknown;
          error?: { code?: number; message?: string };
        },
      };
    }

    beforeAll(async () => {
      accessToken = crypto.randomUUID();
      await api.redis.redis.set(
        `oauth:token:${accessToken}`,
        JSON.stringify({ userId: 0, clientId: "test", scopes: [] }),
        "EX",
        60,
      );
    });

    test("a body that is not JSON returns -32700 with a null id", async () => {
      const { status, body } = await postRaw("{not json");
      expect(status).toBe(400);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error?.code).toBe(-32700);
      expect(body.id).toBe(null);
    });

    test("an empty body returns -32700", async () => {
      const { status, body } = await postRaw("");
      expect(status).toBe(400);
      expect(body.error?.code).toBe(-32700);
    });

    test.each([
      ["a non-JSON-RPC object", JSON.stringify({ hello: "world" })],
      ["a wrong jsonrpc version", JSON.stringify({ jsonrpc: "1.0", id: 1 })],
      ["a request with no method", JSON.stringify({ jsonrpc: "2.0", id: 1 })],
      [
        "a non-object method",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: 42 }),
      ],
      [
        "non-object params",
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: "nope",
        }),
      ],
      ["a bare string", JSON.stringify("tools/list")],
      ["an empty batch", "[]"],
      [
        "a batch with one invalid message",
        JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { nope: true },
        ]),
      ],
    ])("%s returns -32600 Invalid Request with a null id", async (_label, payload) => {
      const { status, body } = await postRaw(payload);
      expect(status).toBe(400);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error?.code).toBe(-32600);
      expect(body.error?.message).toContain("Invalid Request");
      expect(body.id).toBe(null);
    });

    test("a well-formed initialize is still accepted, and a following notification returns 202", async () => {
      const initRes = await fetch(mcpUrl(), {
        method: "POST",
        headers: jsonRpcHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        }),
      });
      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      // Proves the pre-parsed body is handed to the transport rather than the
      // (already consumed) request stream — otherwise this would be a 400.
      const notifyRes = await fetch(mcpUrl(), {
        method: "POST",
        headers: {
          ...jsonRpcHeaders(),
          "mcp-session-id": sessionId!,
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      expect(notifyRes.status).toBe(202);
    });

    test("an invalid message on an existing session is also rejected as -32600", async () => {
      const initRes = await fetch(mcpUrl(), {
        method: "POST",
        headers: jsonRpcHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        }),
      });
      const sessionId = initRes.headers.get("mcp-session-id")!;

      const { status, body } = await postRaw(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: null }),
        sessionId,
      );
      expect(status).toBe(400);
      expect(body.error?.code).toBe(-32600);
    });
  });

  describe("origin gate", () => {
    let originalApplicationUrl: string;
    let originalAllowedOrigins: string;
    let originalMcpAllowedOrigins: string;

    beforeAll(() => {
      originalApplicationUrl = config.server.web.applicationUrl;
      originalAllowedOrigins = config.server.web.allowedOrigins;
      originalMcpAllowedOrigins = config.server.mcp.allowedOrigins;
      // Simulate a public deployment with a locked-down web CORS allowlist, so
      // the MCP-specific allowlist is what admits browser connector origins.
      config.server.web.applicationUrl = "https://api.example.com";
      config.server.web.allowedOrigins = "https://app.example.com";
      config.server.mcp.allowedOrigins = "https://claude.ai,https://claude.com";
    });

    afterAll(() => {
      config.server.web.applicationUrl = originalApplicationUrl;
      config.server.web.allowedOrigins = originalAllowedOrigins;
      config.server.mcp.allowedOrigins = originalMcpAllowedOrigins;
    });

    test("request with no Origin passes (preflight 204)", async () => {
      const res = await fetch(mcpUrl(), {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "POST" },
      });
      expect(res.status).toBe(204);
    });

    test("request with no Origin reaches auth (POST 401, not 403)", async () => {
      const res = await fetch(mcpUrl(), { method: "POST" });
      expect(res.status).toBe(401);
    });

    test("allowlisted origin passes preflight and reflects CORS", async () => {
      const res = await fetch(mcpUrl(), {
        method: "OPTIONS",
        headers: {
          Origin: "https://claude.ai",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://claude.ai",
      );
    });

    test("allowlisted origin POST reaches auth (not 403)", async () => {
      const res = await fetch(mcpUrl(), {
        method: "POST",
        headers: { Origin: "https://claude.ai" },
      });
      expect(res.status).toBe(401);
    });

    test("applicationUrl origin passes", async () => {
      const res = await fetch(mcpUrl(), {
        method: "OPTIONS",
        headers: {
          Origin: "https://api.example.com",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://api.example.com",
      );
    });

    test("non-allowlisted origin is rejected with 403", async () => {
      const res = await fetch(mcpUrl(), {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.com",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(res.status).toBe(403);
    });
  });
});

describe("isMcpSessionAuthorizedForChannel", () => {
  // A channel that only authorizes sessions carrying a userId — the gate that
  // stops MCP notification broadcasts from leaking to unauthorized sessions.
  class AuthedNotifyChannel extends Channel {
    constructor() {
      super({ name: "authed-notify" });
    }
    async authorize(_channelName: string, connection: Connection) {
      if (!connection.session?.data?.userId) {
        throw new TypedError({
          message: "Authentication required to join this channel",
          type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
        });
      }
    }
  }

  let channel: AuthedNotifyChannel;

  useTestServer();

  beforeAll(() => {
    channel = new AuthedNotifyChannel();
    api.channels.channels.push(channel);
  });

  afterAll(() => {
    const idx = api.channels.channels.indexOf(channel);
    if (idx !== -1) api.channels.channels.splice(idx, 1);
  });

  test("authorized when the session's user passes the channel authorize()", async () => {
    const ok = await isMcpSessionAuthorizedForChannel(
      { clientId: "client-1", userId: 123 },
      "authed-notify",
    );
    expect(ok).toBe(true);
  });

  test("denied when the session has no user (fail closed)", async () => {
    const ok = await isMcpSessionAuthorizedForChannel(
      { clientId: "client-1" },
      "authed-notify",
    );
    expect(ok).toBe(false);
  });

  test("denied for an unknown channel (fail closed)", async () => {
    const ok = await isMcpSessionAuthorizedForChannel(
      { clientId: "client-1", userId: 123 },
      "no-such-channel",
    );
    expect(ok).toBe(false);
  });

  test("does not leave the probe connection registered", async () => {
    const before = api.connections.connections.size;
    await isMcpSessionAuthorizedForChannel(
      { clientId: "client-1", userId: 123 },
      "authed-notify",
    );
    expect(api.connections.connections.size).toBe(before);
  });
});

describe("validateJsonRpcPayload", () => {
  test("accepts a request", () => {
    expect(
      validateJsonRpcPayload({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ).toBeUndefined();
  });

  test("accepts a notification", () => {
    expect(
      validateJsonRpcPayload({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toBeUndefined();
  });

  test("accepts a response", () => {
    expect(
      validateJsonRpcPayload({ jsonrpc: "2.0", id: 1, result: {} }),
    ).toBeUndefined();
  });

  test("accepts a batch of well-formed messages (protocol 2025-03-26 clients)", () => {
    expect(
      validateJsonRpcPayload([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
    ).toBeUndefined();
  });

  test.each([
    ["null", null],
    ["a number", 42],
    ["a plain object", { hello: "world" }],
    ["a missing method", { jsonrpc: "2.0", id: 1 }],
    ["a wrong protocol version", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["an empty batch", []],
  ])("rejects %s as INVALID_REQUEST", (_label, payload) => {
    expect(validateJsonRpcPayload(payload)?.code).toBe(
      MCP_JSONRPC_ERROR.INVALID_REQUEST,
    );
  });
});
