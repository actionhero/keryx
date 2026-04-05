import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Action, api, config } from "keryx";
import { z } from "zod";
import * as z4mini from "zod/v4-mini";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

const mcpUrl = () => `${serverUrl()}${config.server.mcp.route}`;
const baseUrl = () => serverUrl();

/**
 * Helper: run the full OAuth flow and return a Bearer access token.
 * Creates a new user via signup each time.
 */
async function getAccessToken(): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `mcp-test-${unique}@example.com`;
  const name = `MCP Test ${unique}`;
  const password = "password123!";
  const redirectUri = "http://localhost:9999/callback";

  // Register OAuth client
  const regRes = await fetch(`${baseUrl()}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "Test Helper Client",
    }),
  });
  const { client_id: clientId } = (await regRes.json()) as {
    client_id: string;
  };

  // PKCE
  const codeVerifier = randomString(43);
  const codeChallenge = await computeS256Challenge(codeVerifier);

  // Signup + get auth code
  const authRes = await fetch(`${baseUrl()}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      mode: "signup",
      name,
      email,
      password,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_type: "code",
      state: "helper",
    }).toString(),
    redirect: "manual",
  });
  const authHtml = await authRes.text();
  const metaMatch = authHtml.match(
    /<meta name="redirect-url" content="([^"]+)"\s*\/?>/,
  );
  const code = new URL(metaMatch![1]).searchParams.get("code")!;

  // Exchange code for token
  const tokenRes = await fetch(`${baseUrl()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const { access_token } = (await tokenRes.json()) as {
    access_token: string;
  };
  return access_token;
}

describe("mcp initializer (disabled)", () => {
  beforeAll(async () => {
    config.server.mcp.enabled = false;
    await api.start();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await api.stop();
  }, HOOK_TIMEOUT);

  test("MCP is disabled by default", () => {
    expect(config.server.mcp.enabled).toBe(false);
  });

  test("/mcp returns 404 when disabled", async () => {
    const res = await fetch(mcpUrl(), { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("mcp initializer (enabled)", () => {
  let accessToken: string;

  beforeAll(async () => {
    config.server.mcp.enabled = true;
    config.rateLimit.enabled = false;
    await api.start();
    accessToken = await getAccessToken();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await api.stop();
    config.server.mcp.enabled = false;
    config.rateLimit.enabled = true;
  }, HOOK_TIMEOUT);

  test("MCP server boots when enabled", () => {
    expect(api.mcp.mcpServers).toBeDefined();
    expect(api.mcp.handleRequest).toBeFunction();
  });

  test("POST without auth returns 401 with WWW-Authenticate header", async () => {
    const res = await fetch(mcpUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toStartWith("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  test("POST initialize with auth returns 200 with session ID", async () => {
    const res = await fetch(mcpUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
  });

  test("OPTIONS returns 204 with CORS headers", async () => {
    const res = await fetch(mcpUrl(), { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBeTruthy();
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "mcp-session-id",
    );
  });

  test("GET without auth returns 401", async () => {
    const res = await fetch(mcpUrl(), { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("GET with auth but no session ID returns 400", async () => {
    const res = await fetch(mcpUrl(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(400);
  });

  test("POST with auth but invalid session ID returns 404", async () => {
    const res = await fetch(mcpUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        "mcp-session-id": "nonexistent-session-id",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(404);
  });

  test("tool name formatting", () => {
    expect(api.mcp.formatToolName("status")).toBe("status");
    expect(api.mcp.formatToolName("user:create")).toBe("user-create");
    expect(api.mcp.formatToolName("messages:list")).toBe("messages-list");
    expect(api.mcp.parseToolName("user-create")).toBe("user:create");
    expect(api.mcp.parseToolName("status")).toBe("status");
  });

  describe("with authenticated MCP client", () => {
    let client: Client;
    let transport: StreamableHTTPClientTransport;

    beforeAll(async () => {
      transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
        requestInit: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      });
      client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(transport);
    });

    afterAll(async () => {
      try {
        await transport.close();
      } catch {
        // ignore close errors
      }
    });

    test("tools/list returns actions as tools (excluding mcp.tool=false)", async () => {
      const result = await client.listTools();
      expect(result.tools.length).toBeGreaterThan(0);

      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("status");

      // Actions with mcp.tool=false should NOT be listed
      expect(toolNames).not.toContain("session-create");
      expect(toolNames).not.toContain("user-create");
      // Resource/prompt example actions should NOT be tools
      expect(toolNames).not.toContain("status-resource");
      expect(toolNames).not.toContain("greeting-prompt");

      // All registered actions with mcp.tool !== false should be tools
      for (const action of api.actions.actions) {
        if (action.mcp?.tool === false) continue;
        expect(toolNames).toContain(api.mcp.formatToolName(action.name));
      }
    });

    test("resources/list returns actions registered as MCP resources", async () => {
      const result = await client.listResources();
      const resourceUris = result.resources.map((r) => r.uri);
      expect(resourceUris).toContain("keryx://status");
    });

    test("resources/read on static URI returns action response as content", async () => {
      const result = await client.readResource({ uri: "keryx://status" });
      expect(result.contents).toBeArray();
      expect(result.contents.length).toBeGreaterThan(0);
      const content = result.contents[0];
      expect(content.uri).toBe("keryx://status");
      expect(content.mimeType).toBe("application/json");
      expect("text" in content).toBe(true);
      const text = (content as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty("name");
      expect(parsed).toHaveProperty("uptime");
    });

    test("prompts/list returns actions registered as MCP prompts", async () => {
      const result = await client.listPrompts();
      const promptNames = result.prompts.map((p) => p.name);
      expect(promptNames).toContain("greeting-prompt");
    });

    test("prompts/get returns messages array", async () => {
      const result = await client.getPrompt({
        name: "greeting-prompt",
        arguments: { name: "Evan" },
      });
      expect(result.messages).toBeArray();
      expect(result.messages.length).toBeGreaterThan(0);
      const msg = result.messages[0];
      expect(msg.role).toBe("user");
      expect(msg.content.type).toBe("text");
      expect((msg.content as { type: string; text: string }).text).toContain(
        "Evan",
      );
    });

    test("prompts/get without arguments uses defaults", async () => {
      const result = await client.getPrompt({
        name: "greeting-prompt",
        arguments: {},
      });
      expect(result.messages).toBeArray();
      const msg = result.messages[0];
      expect((msg.content as { type: string; text: string }).text).toContain(
        "world",
      );
    });

    test("resource action is not in tools/list", async () => {
      const toolsResult = await client.listTools();
      const toolNames = toolsResult.tools.map((t) => t.name);
      expect(toolNames).not.toContain("status-resource");
    });

    test("server instructions are returned from MCP_SERVER_INSTRUCTIONS config", async () => {
      const originalInstructions = config.server.mcp.instructions;

      // Override instructions and create a new session to pick up the change
      (config.server.mcp as any).instructions = "custom test instructions";

      const instrTransport = new StreamableHTTPClientTransport(
        new URL(mcpUrl()),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        },
      );
      const instrClient = new Client({
        name: "instructions-test-client",
        version: "1.0.0",
      });

      try {
        await instrClient.connect(instrTransport);
        expect(instrClient.getInstructions()).toBe("custom test instructions");
      } finally {
        (config.server.mcp as any).instructions = originalInstructions;
        try {
          await instrTransport.close();
        } catch {
          // ignore
        }
      }
    });

    test("tool invocation (status) returns valid response", async () => {
      const result = await client.callTool({
        name: "status",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();

      const content = result.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(content).toBeArray();
      expect(content.length).toBeGreaterThan(0);

      const textContent = content[0];
      expect(textContent.type).toBe("text");
      const parsed = JSON.parse(textContent.text!);
      expect(parsed).toHaveProperty("name");
      expect(parsed).toHaveProperty("version");
      expect(parsed).toHaveProperty("uptime");
    });

    test("session persists across tool calls using OAuth token as sessionId", async () => {
      // Verify the Redis session key is based on the access token, not a random UUID.
      // After a tool call, session:{accessToken} should exist in Redis.
      const sessionKey = `session:${accessToken}`;

      // Make a tool call to trigger session creation
      await client.callTool({ name: "status", arguments: {} });

      // The session should be stored under the OAuth token key
      const sessionData = await api.redis.redis.get(sessionKey);
      expect(sessionData).toBeTruthy();
      const parsed = JSON.parse(sessionData!);
      expect(parsed.id).toBe(accessToken);
      expect(parsed.data.userId).toBeGreaterThan(0);
      const userId = parsed.data.userId;

      // Make a second tool call — should reuse the same session, not create a new one
      await client.callTool({ name: "status", arguments: {} });
      const sessionData2 = await api.redis.redis.get(sessionKey);
      expect(sessionData2).toBeTruthy();
      const parsed2 = JSON.parse(sessionData2!);
      expect(parsed2.id).toBe(accessToken);
      expect(parsed2.data.userId).toBe(userId);
    });

    test("action with responseFormat=markdown returns markdown", async () => {
      const result = await client.callTool({
        name: "status-markdown",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();

      const content = result.content as Array<{
        type: string;
        text?: string;
      }>;
      const text = content[0].text!;

      // Should be markdown, not JSON
      expect(text).toContain("**name**");
      expect(text).toContain("**version**");
      expect(text).toContain("**uptime**");
      // Should NOT be parseable as a JSON object
      expect(() => {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object") throw new Error("is JSON object");
      }).toThrow();
    });

    test("action without responseFormat defaults to JSON", async () => {
      const result = await client.callTool({
        name: "status",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();

      const content = result.content as Array<{
        type: string;
        text?: string;
      }>;
      const parsed = JSON.parse(content[0].text!);
      expect(parsed).toHaveProperty("name");
      expect(typeof parsed).toBe("object");
    });

    test("tool invocation with missing required param returns isError", async () => {
      // user:edit requires authentication (SessionMiddleware) — tool name is "user-edit"
      const result = await client.callTool({
        name: "user-edit",
        arguments: {},
      });
      expect(result.isError).toBe(true);

      const content = result.content as Array<{ type: string }>;
      expect(content).toBeArray();
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe("OAuth endpoints", () => {
    test("protected resource metadata returns authorization server", async () => {
      const res = await fetch(
        `${baseUrl()}/.well-known/oauth-protected-resource`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.resource).toBe(baseUrl());
      expect(body.authorization_servers).toEqual([baseUrl()]);
    });

    test("OAuth metadata endpoint returns valid JSON", async () => {
      const res = await fetch(
        `${baseUrl()}/.well-known/oauth-authorization-server`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.issuer).toBe(baseUrl());
      expect(body.authorization_endpoint).toContain("/oauth/authorize");
      expect(body.token_endpoint).toContain("/oauth/token");
      expect(body.registration_endpoint).toContain("/oauth/register");
      expect(body.response_types_supported).toContain("code");
      expect(body.code_challenge_methods_supported).toContain("S256");
    });

    test("OAuth client registration works", async () => {
      const res = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://localhost:3000/callback"],
          client_name: "Test Client",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.client_id).toBeTruthy();
      expect(body.redirect_uris).toEqual(["http://localhost:3000/callback"]);
      expect(body.client_name).toBe("Test Client");
    });

    test("OAuth registration rejects malformed redirect_uris", async () => {
      const res = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["not-a-url"],
          client_name: "Bad Client",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        error_description: string;
      };
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("Invalid URI");
    });

    test("OAuth registration rejects redirect_uris with fragments", async () => {
      const res = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://localhost:3000/callback#fragment"],
          client_name: "Bad Client",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        error_description: string;
      };
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("fragment");
    });

    test("OAuth registration rejects redirect_uris with userinfo", async () => {
      const res = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://evil.com@trusted.com/callback"],
          client_name: "Bad Client",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        error_description: string;
      };
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("userinfo");
    });

    test("OAuth registration rejects HTTP for non-localhost URIs", async () => {
      const res = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://example.com/callback"],
          client_name: "Bad Client",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        error_description: string;
      };
      expect(body.error).toBe("invalid_request");
      expect(body.error_description).toContain("HTTPS");
    });

    test("OAuth registration accepts HTTPS for non-localhost URIs", async () => {
      const res = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://example.com/callback"],
          client_name: "HTTPS Client",
        }),
      });
      expect(res.status).toBe(201);
    });

    test("OAuth registration accepts HTTP for 127.0.0.1", async () => {
      const res = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://127.0.0.1:3000/callback"],
          client_name: "Loopback Client",
        }),
      });
      expect(res.status).toBe(201);
    });

    test("OAuth authorize rejects non-matching redirect URI", async () => {
      const regRes = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://localhost:9999/callback"],
          client_name: "Mismatch Test",
        }),
      });
      const { client_id: clientId } = (await regRes.json()) as {
        client_id: string;
      };

      const authRes = await fetch(`${baseUrl()}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          mode: "signup",
          name: "Test",
          email: `mismatch-${Date.now()}@example.com`,
          password: "password123!",
          client_id: clientId,
          redirect_uri: "http://localhost:9999/evil-path",
          code_challenge: "abc",
          code_challenge_method: "S256",
          response_type: "code",
          state: "test",
        }).toString(),
        redirect: "manual",
      });
      expect(authRes.status).toBe(200);
      const html = await authRes.text();
      expect(html).toContain("Invalid redirect URI");
    });

    test("OAuth registration has a stricter rate limit than other endpoints", async () => {
      const origEnabled = config.rateLimit.enabled;
      const origLimit = config.rateLimit.oauthRegisterLimit;
      const origWindowMs = config.rateLimit.oauthRegisterWindowMs;
      (config.rateLimit as any).enabled = true;
      (config.rateLimit as any).oauthRegisterLimit = 2;
      (config.rateLimit as any).oauthRegisterWindowMs = 60_000;

      // Clean up any existing rate limit keys
      const keys = await api.redis.redis.keys(
        `${config.rateLimit.keyPrefix}:*`,
      );
      if (keys.length > 0) await api.redis.redis.del(...keys);

      try {
        // First two registrations should succeed
        for (let i = 0; i < 2; i++) {
          const res = await fetch(`${baseUrl()}/oauth/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              redirect_uris: ["http://localhost:3000/callback"],
              client_name: `Rate Limit Test ${i}`,
            }),
          });
          expect(res.status).toBe(201);
        }

        // Third registration should be rate-limited
        const res = await fetch(`${baseUrl()}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            redirect_uris: ["http://localhost:3000/callback"],
            client_name: "Rate Limit Test Blocked",
          }),
        });
        expect(res.status).toBe(429);
        const body = (await res.json()) as {
          error: string;
          error_description: string;
        };
        expect(body.error).toBe("rate_limit_exceeded");
        expect(res.headers.get("Retry-After")).toBeTruthy();

        // Non-register OAuth endpoint should still work (different rate limit)
        const metaRes = await fetch(
          `${baseUrl()}/.well-known/oauth-authorization-server`,
        );
        expect(metaRes.status).toBe(200);
      } finally {
        (config.rateLimit as any).enabled = origEnabled;
        (config.rateLimit as any).oauthRegisterLimit = origLimit;
        (config.rateLimit as any).oauthRegisterWindowMs = origWindowMs;
        const cleanupKeys = await api.redis.redis.keys(
          `${config.rateLimit.keyPrefix}:*`,
        );
        if (cleanupKeys.length > 0) await api.redis.redis.del(...cleanupKeys);
      }
    });

    test("OAuth client registration requires redirect_uris", async () => {
      const res = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Bad Client" }),
      });
      expect(res.status).toBe(400);
    });

    test("OAuth authorize GET returns HTML page", async () => {
      const res = await fetch(
        `${baseUrl()}/oauth/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&code_challenge=abc&code_challenge_method=S256&response_type=code&state=xyz`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("Sign In");
      expect(html).toContain("Sign Up");
    });

    test("OAuth authorize page form fields match login action inputs", async () => {
      const loginAction = api.actions.actions.find(
        (a: Action) => a.mcp?.isLoginAction,
      );
      expect(loginAction).toBeTruthy();
      const expectedFields = Object.keys(
        (loginAction!.inputs as z.ZodObject<any>).shape,
      );

      const res = await fetch(
        `${baseUrl()}/oauth/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&code_challenge=abc&code_challenge_method=S256&response_type=code&state=xyz`,
      );
      const html = await res.text();

      // Extract input names from the signin form section
      const signinSection = html.match(/id="signin-form"[\s\S]*?<\/form>/)?.[0];
      expect(signinSection).toBeTruthy();
      const signinFields = [...signinSection!.matchAll(/name="([^"]+)"/g)]
        .map((m) => m[1])
        .filter(
          (name) =>
            ![
              "mode",
              "client_id",
              "redirect_uri",
              "code_challenge",
              "code_challenge_method",
              "response_type",
              "state",
            ].includes(name),
        );

      expect(signinFields.sort()).toEqual(expectedFields.sort());
    });

    test("OAuth authorize page form fields match signup action inputs", async () => {
      const signupAction = api.actions.actions.find(
        (a: Action) => a.mcp?.isSignupAction,
      );
      expect(signupAction).toBeTruthy();
      const expectedFields = Object.keys(
        (signupAction!.inputs as z.ZodObject<any>).shape,
      );

      const res = await fetch(
        `${baseUrl()}/oauth/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&code_challenge=abc&code_challenge_method=S256&response_type=code&state=xyz`,
      );
      const html = await res.text();

      // Extract input names from the signup form section
      const signupSection = html.match(/id="signup-form"[\s\S]*?<\/form>/)?.[0];
      expect(signupSection).toBeTruthy();
      const signupFields = [...signupSection!.matchAll(/name="([^"]+)"/g)]
        .map((m) => m[1])
        .filter(
          (name) =>
            ![
              "mode",
              "client_id",
              "redirect_uri",
              "code_challenge",
              "code_challenge_method",
              "response_type",
              "state",
            ].includes(name),
        );

      expect(signupFields.sort()).toEqual(expectedFields.sort());
    });

    test("full OAuth flow: register → authorize → token → authenticated tool call", async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const email = `oauth-test-${unique}@example.com`;
      const name = `OAuth Test ${unique}`;
      const password = "password123!";
      const redirectUri = "http://localhost:9999/callback";

      // 1. Register client
      const regRes = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          client_name: "OAuth Test Client",
        }),
      });
      expect(regRes.status).toBe(201);
      const { client_id: clientId } = (await regRes.json()) as {
        client_id: string;
      };

      // 2. Generate PKCE challenge
      const codeVerifier = randomString(43);
      const codeChallenge = await computeS256Challenge(codeVerifier);

      // 3. POST to authorize (signup mode) — should redirect with code
      const authForm = new URLSearchParams({
        mode: "signup",
        name,
        email,
        password,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        response_type: "code",
        state: "test-state",
      });

      const authRes = await fetch(`${baseUrl()}/oauth/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: authForm.toString(),
        redirect: "manual",
      });
      expect(authRes.status).toBe(200);
      const authHtml = await authRes.text();
      const metaMatch = authHtml.match(
        /<meta name="redirect-url" content="([^"]+)"\s*\/?>/,
      );
      expect(metaMatch).toBeTruthy();
      const redirectUrl = new URL(metaMatch![1]);
      const code = redirectUrl.searchParams.get("code");
      expect(code).toBeTruthy();
      expect(redirectUrl.searchParams.get("state")).toBe("test-state");

      // 4. Exchange code for token
      const tokenRes = await fetch(`${baseUrl()}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = (await tokenRes.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
      };
      expect(tokenBody.access_token).toBeTruthy();
      expect(tokenBody.token_type).toBe("Bearer");
      expect(tokenBody.expires_in).toBeGreaterThan(0);

      // 5. Use the Bearer token with MCP to call an authenticated tool
      const authTransport = new StreamableHTTPClientTransport(
        new URL(mcpUrl()),
        {
          requestInit: {
            headers: {
              Authorization: `Bearer ${tokenBody.access_token}`,
            },
          },
        },
      );
      const authClient = new Client({
        name: "oauth-test-client",
        version: "1.0.0",
      });
      await authClient.connect(authTransport);

      try {
        // Call message-create which requires auth (SessionMiddleware)
        const msgResult = await authClient.callTool({
          name: "message-create",
          arguments: { body: "Hello from OAuth" },
        });
        expect(msgResult.isError).toBeFalsy();
        const content = msgResult.content as Array<{
          type: string;
          text?: string;
        }>;
        const parsed = JSON.parse(content[0].text!);
        expect(parsed).toHaveProperty("message");
        expect(parsed.message.body).toBe("Hello from OAuth");
      } finally {
        try {
          await authTransport.close();
        } catch {
          // ignore
        }
      }
    });

    test("end-to-end: create user, sign in, post message", async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const email = `e2e-${unique}@example.com`;
      const name = `E2E User ${unique}`;
      const password = "testpassword99!";
      const redirectUri = "http://localhost:9999/callback";

      // --- Register an OAuth client ---
      const regRes = await fetch(`${baseUrl()}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [redirectUri],
          client_name: "E2E Test Client",
        }),
      });
      expect(regRes.status).toBe(201);
      const { client_id: clientId } = (await regRes.json()) as {
        client_id: string;
      };

      // --- 1. Create user via OAuth signup ---
      const signupVerifier = randomString(43);
      const signupChallenge = await computeS256Challenge(signupVerifier);

      const signupRes = await fetch(`${baseUrl()}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          mode: "signup",
          name,
          email,
          password,
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: signupChallenge,
          code_challenge_method: "S256",
          response_type: "code",
          state: "signup",
        }).toString(),
        redirect: "manual",
      });
      expect(signupRes.status).toBe(200);
      // We don't exchange this code — the user is now created in the DB

      // --- 2. Sign in as the created user via OAuth signin ---
      const signinVerifier = randomString(43);
      const signinChallenge = await computeS256Challenge(signinVerifier);

      const signinRes = await fetch(`${baseUrl()}/oauth/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          mode: "signin",
          email,
          password,
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: signinChallenge,
          code_challenge_method: "S256",
          response_type: "code",
          state: "signin",
        }).toString(),
        redirect: "manual",
      });
      expect(signinRes.status).toBe(200);

      const signinHtml = await signinRes.text();
      const signinMetaMatch = signinHtml.match(
        /<meta name="redirect-url" content="([^"]+)"\s*\/?>/,
      );
      expect(signinMetaMatch).toBeTruthy();
      const signinRedirect = new URL(signinMetaMatch![1]);
      const signinCode = signinRedirect.searchParams.get("code");
      expect(signinCode).toBeTruthy();
      expect(signinRedirect.searchParams.get("state")).toBe("signin");

      // --- Exchange signin code for access token ---
      const tokenRes = await fetch(`${baseUrl()}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: signinCode!,
          code_verifier: signinVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const { access_token: e2eAccessToken } = (await tokenRes.json()) as {
        access_token: string;
      };
      expect(e2eAccessToken).toBeTruthy();

      // --- 3. Post a message via authenticated MCP tool call ---
      const authTransport = new StreamableHTTPClientTransport(
        new URL(mcpUrl()),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${e2eAccessToken}` },
          },
        },
      );
      const authClient = new Client({
        name: "e2e-test-client",
        version: "1.0.0",
      });
      await authClient.connect(authTransport);

      try {
        const msgResult = await authClient.callTool({
          name: "message-create",
          arguments: { body: "Hello from E2E test" },
        });
        expect(msgResult.isError).toBeFalsy();

        const content = msgResult.content as Array<{
          type: string;
          text?: string;
        }>;
        const parsed = JSON.parse(content[0].text!);
        expect(parsed).toHaveProperty("message");
        expect(parsed.message.body).toBe("Hello from E2E test");
        expect(parsed.message.user_id).toBeGreaterThan(0);

        // Verify the message is retrievable via messages-list
        const listResult = await authClient.callTool({
          name: "messages-list",
          arguments: { limit: "5" },
        });
        expect(listResult.isError).toBeFalsy();

        const listContent = listResult.content as Array<{
          type: string;
          text?: string;
        }>;
        const listParsed = JSON.parse(listContent[0].text!);
        expect(listParsed.messages).toBeArray();
        const ourMessage = listParsed.messages.find(
          (m: any) => m.body === "Hello from E2E test",
        );
        expect(ourMessage).toBeTruthy();
        expect(ourMessage.user_name).toBe(name);
      } finally {
        try {
          await authTransport.close();
        } catch {
          // ignore
        }
      }
    });

    test("unauthenticated MCP connection returns 401", async () => {
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()));
      const client = new Client({
        name: "noauth-test-client",
        version: "1.0.0",
      });

      try {
        await client.connect(transport);
        // If connect doesn't throw, the SDK may have handled the 401 differently
        // In that case, fail the test
        expect(true).toBe(false);
      } catch (e) {
        // Expected: the MCP SDK throws when the server returns 401
        expect(String(e)).toContain("Authentication required");
      } finally {
        try {
          await transport.close();
        } catch {
          // ignore
        }
      }
    });
  });

  describe("schema sanitization", () => {
    test("simple schemas pass through unchanged", () => {
      const schema = z.object({ name: z.string(), age: z.number() });
      const sanitized = api.mcp.sanitizeSchemaForMcp(schema);
      expect(sanitized).toBe(schema); // same reference = no sanitization needed
    });

    test("schemas with Date fields get sanitized", () => {
      const schema = z.object({
        name: z.string(),
        createdAt: z.date(),
      });
      const sanitized = api.mcp.sanitizeSchemaForMcp(schema);
      expect(sanitized).not.toBe(schema); // different reference = was sanitized

      // Should not throw when converting to JSON Schema
      const jsonSchema = z4mini.toJSONSchema(sanitized, {
        target: "draft-7",
        io: "input",
      });
      expect(jsonSchema).toHaveProperty("properties");
      expect((jsonSchema as any).properties.name.type).toBe("string");
      expect((jsonSchema as any).properties.createdAt.type).toBe("string");
    });

    test("schemas with union types containing Date get sanitized", () => {
      const schema = z.object({
        user: z.union([
          z.coerce.number(),
          z.object({ id: z.number(), createdAt: z.date() }),
        ]),
      });
      const sanitized = api.mcp.sanitizeSchemaForMcp(schema);
      const jsonSchema = z4mini.toJSONSchema(sanitized, {
        target: "draft-7",
        io: "input",
      });
      expect(jsonSchema).toHaveProperty("properties");
    });

    test("empty object schemas get additionalProperties: false", () => {
      const schema = z.object({});
      const sanitized = api.mcp.sanitizeSchemaForMcp(schema);
      const jsonSchema = z4mini.toJSONSchema(sanitized, {
        target: "draft-7",
        io: "input",
      });
      expect((jsonSchema as any).type).toBe("object");
      expect((jsonSchema as any).additionalProperties).toBe(false);
    });

    test("non-object schemas pass through", () => {
      expect(api.mcp.sanitizeSchemaForMcp(null)).toBeNull();
      expect(api.mcp.sanitizeSchemaForMcp(undefined)).toBeUndefined();
      expect(api.mcp.sanitizeSchemaForMcp("not-a-schema")).toBe("not-a-schema");
    });
  });

  test("notification forwarding is set up", () => {
    expect(typeof api.mcp.sendNotification).toBe("function");
  });
});

// --- Helper functions ---

function randomString(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function computeS256Challenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
