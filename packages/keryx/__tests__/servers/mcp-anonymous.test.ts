import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { api } from "../../api";
import { Action, HTTP_METHOD } from "../../classes/Action";
import { config } from "../../config";
import {
  ANONYMOUS_MCP_CLIENT_ID,
  createMcpServer,
  mcpSessionKey,
  readMcpSessionRecord,
} from "../../util/mcpServer";
import { serverUrl, useTestServer } from "../setup";

const mcpUrl = () => `${serverUrl()}${config.server.mcp.route}`;

class PublicTool extends Action {
  constructor() {
    super({
      name: "test:anon-public",
      description: "A tool anonymous clients may call",
      inputs: z.object({ name: z.string().optional() }),
      mcp: { tool: true, public: true },
      web: { route: "/test-anon-public", method: HTTP_METHOD.GET },
    });
  }
  async run(params: { name?: string }) {
    return { greeting: `hello ${params.name ?? "anon"}` };
  }
}

class PrivateTool extends Action {
  constructor() {
    super({
      name: "test:anon-private",
      description: "A tool that requires authentication",
      mcp: { tool: true },
      web: { route: "/test-anon-private", method: HTTP_METHOD.GET },
    });
  }
  async run() {
    return { secret: true };
  }
}

class PublicResource extends Action {
  constructor() {
    super({
      name: "test:anon-public-resource",
      mcp: {
        public: true,
        resource: { uri: "keryx://test-anon/public", mimeType: "text/plain" },
      },
      web: { route: "/test-anon-public-resource", method: HTTP_METHOD.GET },
    });
  }
  async run() {
    return { text: "public resource" };
  }
}

class PrivateResource extends Action {
  constructor() {
    super({
      name: "test:anon-private-resource",
      mcp: {
        resource: {
          uriTemplate: "keryx://test-anon/private/{id}",
          mimeType: "text/plain",
        },
      },
      inputs: z.object({ id: z.string() }),
      web: {
        route: "/test-anon-private-resource/:id",
        method: HTTP_METHOD.GET,
      },
    });
  }
  async run(params: { id: string }) {
    return { text: `private ${params.id}` };
  }
}

class PrivatePrompt extends Action {
  constructor() {
    super({
      name: "test:anon-private-prompt",
      mcp: { prompt: { title: "Private prompt" } },
      web: { route: "/test-anon-private-prompt", method: HTTP_METHOD.GET },
    });
  }
  async run() {
    return {
      messages: [
        { role: "user" as const, content: { type: "text", text: "hi" } },
      ],
    };
  }
}

/** Put an access token straight into Redis, skipping the OAuth flow. */
async function issueToken(clientId: string, userId = 0): Promise<string> {
  const token = crypto.randomUUID();
  await api.redis.redis.set(
    `oauth:token:${token}`,
    JSON.stringify({ userId, clientId, scopes: [] }),
    "EX",
    60,
  );
  return token;
}

let rpcId = 0;
const initializeMessage = () => ({
  jsonrpc: "2.0",
  id: ++rpcId,
  method: "initialize",
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "anon-test", version: "1.0.0" },
  },
});
const callToolMessage = (name: string) => ({
  jsonrpc: "2.0",
  id: ++rpcId,
  method: "tools/call",
  params: { name, arguments: {} },
});

/** POST a JSON-RPC body to the MCP endpoint, optionally on a session / with a token. */
async function post(
  body: unknown,
  opts: { sessionId?: string; token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (opts.sessionId) {
    headers["mcp-session-id"] = opts.sessionId;
    headers["mcp-protocol-version"] = LATEST_PROTOCOL_VERSION;
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return fetch(mcpUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Run `initialize` (+ `notifications/initialized`) and return the session id. */
async function openSession(token?: string): Promise<string> {
  const res = await post(initializeMessage(), { token });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeString();
  await res.text();
  const ack = await post(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { sessionId: sessionId!, token },
  );
  await ack.text();
  return sessionId!;
}

describe("anonymous MCP access", () => {
  const testActions: Action[] = [];
  const originalAuthMode = config.server.mcp.authMode;
  const originalRateLimitEnabled = config.rateLimit.enabled;

  beforeAll(() => {
    config.server.mcp.enabled = true;
    // Many sessions are opened from one IP; only the rate-limit block below
    // turns limiting on.
    config.rateLimit.enabled = false;
  });

  useTestServer();

  beforeAll(() => {
    testActions.push(
      new PublicTool(),
      new PrivateTool(),
      new PublicResource(),
      new PrivateResource(),
      new PrivatePrompt(),
    );
    api.actions.actions.push(...testActions);
  });

  afterAll(() => {
    config.server.mcp.enabled = false;
    config.server.mcp.authMode = originalAuthMode;
    config.rateLimit.enabled = originalRateLimitEnabled;
    for (const action of testActions) {
      const idx = api.actions.actions.indexOf(action);
      if (idx !== -1) api.actions.actions.splice(idx, 1);
    }
  });

  describe("required mode (default)", () => {
    beforeEach(() => {
      config.server.mcp.authMode = "required";
    });

    test("initialize without a token is challenged with 401", async () => {
      const res = await post(initializeMessage());
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        "resource_metadata=",
      );
    });
  });

  describe("optional mode", () => {
    beforeEach(() => {
      config.server.mcp.authMode = "optional";
    });

    test("initialize without a token opens an anonymous session with the short TTL", async () => {
      const sessionId = await openSession();
      const record = await readMcpSessionRecord(sessionId);
      expect(record?.anonymous).toBe(true);
      expect(record?.clientId).toBe(ANONYMOUS_MCP_CLIENT_ID);
      const ttl = await api.redis.redis.ttl(mcpSessionKey(sessionId));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(config.server.mcp.anonymousSessionTtl);
    });

    test("an anonymous SDK client lists every tool and calls a public one", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()));
      const client = new Client({ name: "anon", version: "1.0.0" });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        expect(names).toContain("test-anon-public");
        expect(names).toContain("test-anon-private");

        const result = await client.callTool({
          name: "test-anon-public",
          arguments: { name: "world" },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({ greeting: "hello world" });

        const resource = await client.readResource({
          uri: "keryx://test-anon/public",
        });
        expect((resource.contents[0] as { text: string }).text).toBe(
          "public resource",
        );
      } finally {
        await transport.close().catch(() => {});
      }
    });

    test("an anonymous call to a protected tool is challenged with 401", async () => {
      const sessionId = await openSession();
      const res = await post(callToolMessage("test-anon-private"), {
        sessionId,
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(
        `resource_metadata="${serverUrl()}/.well-known/oauth-protected-resource${config.server.mcp.route}"`,
      );
    });

    test("a batch containing a protected call is challenged with 401", async () => {
      const sessionId = await openSession();
      const res = await post(
        [
          callToolMessage("test-anon-public"),
          callToolMessage("test-anon-private"),
        ],
        { sessionId },
      );
      expect(res.status).toBe(401);
    });

    test("anonymous reads of a protected resource template or prompt are challenged with 401", async () => {
      const sessionId = await openSession();
      const resourceRes = await post(
        {
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "resources/read",
          params: { uri: "keryx://test-anon/private/42" },
        },
        { sessionId },
      );
      expect(resourceRes.status).toBe(401);

      const promptRes = await post(
        {
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "prompts/get",
          params: { name: "test-anon-private-prompt" },
        },
        { sessionId },
      );
      expect(promptRes.status).toBe(401);
    });

    test("an unknown tool is not challenged (the SDK answers not-found)", async () => {
      const sessionId = await openSession();
      const res = await post(callToolMessage("does-not-exist"), { sessionId });
      expect(res.status).toBe(200);
    });

    test("an invalid token is rejected with 401, not treated as anonymous", async () => {
      const res = await post(initializeMessage(), { token: "not-a-token" });
      expect(res.status).toBe(401);
    });

    test("a token upgrades an anonymous session once, then binds it to that client", async () => {
      const sessionId = await openSession();
      const token = await issueToken("upgrade-client", 7);

      // The protected call that was challenged now succeeds with a token.
      const upgraded = await post(callToolMessage("test-anon-private"), {
        sessionId,
        token,
      });
      expect(upgraded.status).toBe(200);
      const body = (await upgraded.json()) as {
        result: { isError?: boolean; structuredContent?: unknown };
      };
      expect(body.result.isError).toBeFalsy();
      expect(body.result.structuredContent).toEqual({ secret: true });

      const record = await readMcpSessionRecord(sessionId);
      expect(record?.clientId).toBe("upgrade-client");
      expect(record?.anonymous).toBeUndefined();
      const ttl = await api.redis.redis.ttl(mcpSessionKey(sessionId));
      expect(ttl).toBeGreaterThan(config.server.mcp.anonymousSessionTtl);

      const localAuth = [...api.mcp.mcpServerAuth.values()].find(
        (a) => a.clientId === "upgrade-client",
      );
      expect(localAuth?.userId).toBe(7);

      // No downgrade back to anonymous...
      const anon = await post(callToolMessage("test-anon-public"), {
        sessionId,
      });
      expect(anon.status).toBe(401);

      // ...and no second upgrade by a different client.
      const otherToken = await issueToken("other-client");
      const other = await post(callToolMessage("test-anon-public"), {
        sessionId,
        token: otherToken,
      });
      expect(other.status).toBe(403);
    });

    test("concurrent upgrades by two clients: exactly one wins", async () => {
      const sessionId = await openSession();
      const [tokenA, tokenB] = await Promise.all([
        issueToken("race-a"),
        issueToken("race-b"),
      ]);
      const responses = await Promise.all([
        post(callToolMessage("test-anon-public"), { sessionId, token: tokenA }),
        post(callToolMessage("test-anon-public"), { sessionId, token: tokenB }),
      ]);
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 403]);
      await Promise.all(responses.map((r) => r.text()));

      const record = await readMcpSessionRecord(sessionId);
      const winner = responses[0].status === 200 ? "race-a" : "race-b";
      expect(record?.clientId).toBe(winner);
    });

    test("an authenticated session still works and is not marked anonymous", async () => {
      const token = await issueToken("authed-client");
      const sessionId = await openSession(token);
      const record = await readMcpSessionRecord(sessionId);
      expect(record?.anonymous).toBeUndefined();
      const res = await post(callToolMessage("test-anon-private"), {
        sessionId,
        token,
      });
      expect(res.status).toBe(200);
    });

    test("an authenticated client can get a prompt that declares no inputs", async () => {
      const token = await issueToken("prompt-client");
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      const client = new Client({ name: "authed", version: "1.0.0" });
      await client.connect(transport);
      try {
        const prompt = await client.getPrompt({
          name: "test-anon-private-prompt",
        });
        expect(prompt.messages).toHaveLength(1);
      } finally {
        await transport.close().catch(() => {});
      }
    });

    describe("rate limiting", () => {
      const originalInitLimit = config.rateLimit.mcpAnonymousInitLimit;

      beforeEach(async () => {
        const keys = await api.redis.redis.keys(
          `${config.rateLimit.keyPrefix}:mcp-anon*`,
        );
        if (keys.length > 0) await api.redis.redis.del(...keys);
        config.rateLimit.enabled = true;
        config.rateLimit.mcpAnonymousInitLimit = 1;
      });

      afterAll(() => {
        config.rateLimit.enabled = false;
        config.rateLimit.mcpAnonymousInitLimit = originalInitLimit;
      });

      test("new anonymous sessions beyond the limit get 429", async () => {
        const first = await post(initializeMessage());
        expect(first.status).toBe(200);
        await first.text();

        const second = await post(initializeMessage());
        expect(second.status).toBe(429);
        expect(second.headers.get("retry-after")).toBeString();
        const body = (await second.json()) as { error: string };
        expect(body.error).toBe("rate_limit_exceeded");
      });

      test("authenticated sessions are not subject to the anonymous limit", async () => {
        const token = await issueToken("rate-client");
        for (let i = 0; i < 3; i++) {
          const res = await post(initializeMessage(), { token });
          expect(res.status).toBe(200);
          await res.text();
        }
      });
    });
  });

  describe("handler-level guard", () => {
    // Bypasses the HTTP layer entirely: requests reach the McpServer with no
    // auth context, which must be treated as anonymous (fail closed).
    async function connectWithoutAuth() {
      const server = createMcpServer();
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "in-memory", version: "1.0.0" });
      await client.connect(clientTransport);
      return { client, server };
    }

    test("a protected tool returns an authentication error without auth context", async () => {
      const { client, server } = await connectWithoutAuth();
      try {
        const result = await client.callTool({
          name: "test-anon-private",
          arguments: {},
        });
        expect(result.isError).toBe(true);
        const text = (result.content as { text: string }[])[0].text;
        expect(text).toContain("Authentication required");
      } finally {
        await client.close();
        await server.close();
      }
    });

    test("a public tool runs without auth context", async () => {
      const { client, server } = await connectWithoutAuth();
      try {
        const result = await client.callTool({
          name: "test-anon-public",
          arguments: {},
        });
        expect(result.isError).toBeFalsy();
      } finally {
        await client.close();
        await server.close();
      }
    });

    test("protected resources and prompts throw without auth context", async () => {
      const { client, server } = await connectWithoutAuth();
      try {
        expect(
          client.readResource({ uri: "keryx://test-anon/private/1" }),
        ).rejects.toThrow("Authentication required");
        expect(
          client.getPrompt({ name: "test-anon-private-prompt" }),
        ).rejects.toThrow("Authentication required");
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
