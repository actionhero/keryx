import { beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type ActionResponse, api, config } from "keryx";
import type { GreetingPrompt, StatusResource } from "../../actions/mcp";
import { serverUrl, useTestServer } from "./../setup";

beforeAll(() => {
  config.server.mcp.enabled = true;
});

const getUrl = useTestServer();
const mcpUrl = () => `${serverUrl()}${config.server.mcp.route}`;

describe("status:resource", () => {
  test("GET /status/resource returns a JSON resource payload", async () => {
    const res = await fetch(getUrl() + "/api/status/resource");
    expect(res.status).toBe(200);

    const response = (await res.json()) as ActionResponse<StatusResource>;
    expect(response.mimeType).toBe("application/json");
    expect(typeof response.text).toBe("string");

    const payload = JSON.parse(response.text) as {
      name: string;
      pid: number;
      version: string;
      uptime: number;
      consumedMemoryMB: number;
    };
    expect(payload.name).toBeDefined();
    expect(typeof payload.pid).toBe("number");
    expect(payload.version).toBeDefined();
    expect(payload.uptime).toBeGreaterThanOrEqual(0);
    expect(payload.consumedMemoryMB).toBeGreaterThan(0);
  });
});

describe("greeting:prompt", () => {
  test("GET /greeting/prompt defaults to 'world' when no name is provided", async () => {
    const res = await fetch(getUrl() + "/api/greeting/prompt");
    expect(res.status).toBe(200);

    const response = (await res.json()) as ActionResponse<GreetingPrompt>;
    expect(response.description).toBe("A personalized greeting");
    expect(response.messages).toHaveLength(1);

    const message = response.messages[0];
    expect(message.role).toBe("user");
    expect(message.content.type).toBe("text");
    expect(message.content.text).toContain("Hello, world!");
  });

  test("GET /greeting/prompt?name=... personalizes the greeting", async () => {
    const res = await fetch(getUrl() + "/api/greeting/prompt?name=Mario");
    expect(res.status).toBe(200);

    const response = (await res.json()) as ActionResponse<GreetingPrompt>;
    const message = response.messages[0];
    expect(message.content.text).toBe(
      "Hello, Mario! How can I help you today?",
    );
  });
});

describe("status:app (MCP App)", () => {
  test("GET /status/app returns the structuredContent (UIResponse serializes via toJSON)", async () => {
    const res = await fetch(getUrl() + "/api/status/app");
    expect(res.status).toBe(200);

    // Over HTTP a UIResponse serializes to its structuredContent, so the same
    // action is useful outside of MCP too.
    const payload = (await res.json()) as {
      name: string;
      pid: number;
      version: string;
      uptime: number;
      consumedMemoryMB: number;
      healthy: boolean;
      checks: { database: boolean; redis: boolean };
    };
    expect(payload.name).toBeDefined();
    expect(typeof payload.pid).toBe("number");
    expect(payload.version).toBeDefined();
    expect(payload.uptime).toBeGreaterThanOrEqual(0);
    expect(payload.consumedMemoryMB).toBeGreaterThan(0);
    // status:app now projects the same health field set as /status so the app
    // UI has live runtime state to bind against, not just text.
    expect(typeof payload.healthy).toBe("boolean");
    expect(typeof payload.checks.database).toBe("boolean");
    expect(typeof payload.checks.redis).toBe("boolean");
  });
});

describe("MCP elicitation examples", () => {
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

  test("user-confirm-display-name elicits a form field", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const client = new Client(
      { name: "example-elicitation", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, () => ({
      action: "accept",
      content: { displayName: "Ada" },
    }));
    await client.connect(transport);

    try {
      const result = await client.callTool({
        name: "user-confirm-display-name",
        arguments: {},
      });
      expect(result.structuredContent).toEqual({
        saved: true,
        displayName: "Ada",
      });
    } finally {
      await transport.close();
    }
  });

  test("secrets-link-api-key waits for the HTTP page to complete", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const client = new Client(
      { name: "example-elicitation", version: "1.0.0" },
      { capabilities: { elicitation: { form: {}, url: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode !== "url") {
        throw new Error("expected URL elicitation");
      }
      const page = await fetch(
        `${getUrl()}/api/secrets/api-key?elicitationId=${request.params.elicitationId}`,
      );
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Store API key");

      const submit = await fetch(`${getUrl()}/api/secrets/api-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elicitationId: request.params.elicitationId,
          apiKey: "sk-test",
        }),
      });
      expect(submit.status).toBe(200);
      return { action: "accept" };
    });
    await client.connect(transport);

    try {
      const result = await client.callTool({
        name: "secrets-link-api-key",
        arguments: {},
      });
      expect(result.structuredContent).toEqual({ linked: true });
    } finally {
      await transport.close();
    }
  });
});
