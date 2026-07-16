import { describe, expect, test } from "bun:test";
import { type ActionResponse } from "keryx";
import type { GreetingPrompt, StatusResource } from "../../actions/mcp";
import { useTestServer } from "./../setup";

const getUrl = useTestServer();

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
