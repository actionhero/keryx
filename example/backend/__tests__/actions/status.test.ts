import { describe, expect, test } from "bun:test";
import { type ActionResponse } from "keryx";
import type { Status, StatusMarkdown } from "../../actions/status";
import { useTestServer } from "./../setup";

const getUrl = useTestServer();

describe("status", () => {
  test("GET /status returns healthy runtime information", async () => {
    const res = await fetch(getUrl() + "/api/status");
    expect(res.status).toBe(200);

    const response = (await res.json()) as ActionResponse<Status>;
    expect(response.name).toBeDefined();
    expect(typeof response.pid).toBe("number");
    expect(response.pid).toBeGreaterThan(0);
    expect(response.version).toBeDefined();
    expect(response.uptime).toBeGreaterThanOrEqual(0);
    expect(response.consumedMemoryMB).toBeGreaterThan(0);
  });

  test("reports database and redis as healthy in the test environment", async () => {
    const res = await fetch(getUrl() + "/api/status");
    const response = (await res.json()) as ActionResponse<Status>;

    expect(response.checks.database).toBe(true);
    expect(response.checks.redis).toBe(true);
    expect(response.healthy).toBe(true);
  });

  test("requires no authentication", async () => {
    // No Cookie header, no auth — status must still return 200.
    const res = await fetch(getUrl() + "/api/status", {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    await res.json();
  });
});

describe("status:markdown", () => {
  test("GET /status/markdown returns the same shape as /status", async () => {
    const res = await fetch(getUrl() + "/api/status/markdown");
    expect(res.status).toBe(200);

    const response = (await res.json()) as ActionResponse<StatusMarkdown>;
    expect(response.name).toBeDefined();
    expect(typeof response.pid).toBe("number");
    expect(response.healthy).toBe(true);
    expect(response.checks.database).toBe(true);
    expect(response.checks.redis).toBe(true);
  });
});
