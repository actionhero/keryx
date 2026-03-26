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
import { config } from "../../config";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

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

  beforeAll(async () => {
    config.server.mcp.enabled = true;
    await api.start();

    // Inject test actions after start (api.actions is now populated).
    // MCP servers are created per-session, so these will be picked up
    // when the test client connects.
    const templateResource = new TestTemplateResource();
    const prompt = new TestPrompt();
    testActions.push(templateResource, prompt);
    api.actions.actions.push(...testActions);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await api.stop();
    config.server.mcp.enabled = false;

    // Remove injected test actions
    for (const action of testActions) {
      const idx = api.actions.actions.indexOf(action);
      if (idx !== -1) api.actions.actions.splice(idx, 1);
    }
  }, HOOK_TIMEOUT);

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
});
