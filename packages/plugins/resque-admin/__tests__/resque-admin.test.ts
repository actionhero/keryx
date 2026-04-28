import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { config } from "keryx/config";
import { parseRedisInfo } from "../actions/redisInfo";
import { resqueAdminPlugin } from "../index";
import { safeCompare } from "../middleware/password";
import { HOOK_TIMEOUT, serverUrl } from "./setup";

const TEST_PASSWORD = "test-resque-admin-pw";

describe("resque-admin plugin", () => {
  beforeAll(async () => {
    config.plugins.push(resqueAdminPlugin);
    (config as unknown as { resqueAdmin: { password: string } }).resqueAdmin = {
      password: TEST_PASSWORD,
    };
    await api.start();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await api.stop();
  }, HOOK_TIMEOUT);

  describe("password middleware", () => {
    test("returns 406 with no password (Zod validation rejects missing field)", async () => {
      const res = await fetch(`${serverUrl()}/api/resque-admin/overview`);
      expect(res.status).toBe(406);
    });

    test("returns 401 with wrong password", async () => {
      const res = await fetch(
        `${serverUrl()}/api/resque-admin/overview?password=wrong`,
      );
      expect(res.status).toBe(401);
    });

    test("returns 200 with correct password", async () => {
      const res = await fetch(
        `${serverUrl()}/api/resque-admin/overview?password=${TEST_PASSWORD}`,
      );
      expect(res.status).toBe(200);
    });
  });

  describe("UI", () => {
    test("serves HTML without password", async () => {
      const res = await fetch(`${serverUrl()}/api/resque-admin`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("Resque Admin");
    });
  });

  describe("overview", () => {
    test("returns expected shape", async () => {
      const res = await fetch(
        `${serverUrl()}/api/resque-admin/overview?password=${TEST_PASSWORD}`,
      );
      const data = (await res.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("queues");
      expect(data).toHaveProperty("workers");
      expect(data).toHaveProperty("stats");
      expect(data).toHaveProperty("leader");
      expect(data).toHaveProperty("failedCount");
      expect(typeof data.failedCount).toBe("number");
    });
  });

  describe("failed", () => {
    test("returns totalFailed and jobs array", async () => {
      const res = await fetch(
        `${serverUrl()}/api/resque-admin/failed?password=${TEST_PASSWORD}`,
      );
      const data = (await res.json()) as {
        totalFailed: number;
        jobs: unknown[];
      };
      expect(data).toHaveProperty("totalFailed");
      expect(data).toHaveProperty("jobs");
      expect(typeof data.totalFailed).toBe("number");
      expect(Array.isArray(data.jobs)).toBe(true);
    });
  });

  describe("locks", () => {
    test("returns locks object", async () => {
      const res = await fetch(
        `${serverUrl()}/api/resque-admin/locks?password=${TEST_PASSWORD}`,
      );
      const data = (await res.json()) as { locks: Record<string, unknown> };
      expect(data).toHaveProperty("locks");
      expect(typeof data.locks).toBe("object");
    });
  });

  describe("delayed", () => {
    test("returns delayed object", async () => {
      const res = await fetch(
        `${serverUrl()}/api/resque-admin/delayed?password=${TEST_PASSWORD}`,
      );
      const data = (await res.json()) as { delayed: Record<string, unknown> };
      expect(data).toHaveProperty("delayed");
      expect(typeof data.delayed).toBe("object");
    });
  });

  describe("redis-info", () => {
    test("returns parsed sections", async () => {
      const res = await fetch(
        `${serverUrl()}/api/resque-admin/redis-info?password=${TEST_PASSWORD}`,
      );
      const data = (await res.json()) as {
        sections: Record<string, Record<string, string>>;
      };
      expect(data).toHaveProperty("sections");
      expect(typeof data.sections).toBe("object");
      // Redis INFO always has a "server" section
      expect(data.sections).toHaveProperty("server");
    });
  });

  describe("enqueue and queue inspection", () => {
    test("enqueue creates a job visible in queue", async () => {
      const enqueueRes = await fetch(
        `${serverUrl()}/api/resque-admin/enqueue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            password: TEST_PASSWORD,
            actionName: "status",
            inputs: "{}",
            queue: "test-admin-queue",
          }),
        },
      );
      expect(enqueueRes.status).toBe(200);
      const enqueueData = (await enqueueRes.json()) as { success: boolean };
      expect(enqueueData.success).toBe(true);

      // Inspect the queue
      const queueRes = await fetch(
        `${serverUrl()}/api/resque-admin/queue/test-admin-queue?password=${TEST_PASSWORD}`,
      );
      expect(queueRes.status).toBe(200);
      const queueData = (await queueRes.json()) as {
        queue: string;
        jobs: unknown[];
      };
      expect(queueData.queue).toBe("test-admin-queue");
      expect(queueData.jobs.length).toBeGreaterThanOrEqual(1);

      // Clean up: delete the queue
      const delRes = await fetch(`${serverUrl()}/api/resque-admin/del-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: TEST_PASSWORD,
          queue: "test-admin-queue",
        }),
      });
      expect(delRes.status).toBe(200);
    });
  });

  describe("safeCompare", () => {
    test("returns true for matching strings", () => {
      expect(safeCompare("secret", "secret")).toBe(true);
    });

    test("returns false for different strings", () => {
      expect(safeCompare("secret", "wrong")).toBe(false);
    });

    test("returns false for different-length strings", () => {
      expect(safeCompare("short", "a-much-longer-string")).toBe(false);
    });

    test("returns false for empty vs non-empty", () => {
      expect(safeCompare("", "non-empty")).toBe(false);
    });

    test("returns true for two empty strings", () => {
      expect(safeCompare("", "")).toBe(true);
    });
  });

  describe("parseRedisInfo", () => {
    test("parses sections and key:value pairs", () => {
      const raw =
        "# Server\r\nredis_version:7.0.0\r\nredis_mode:standalone\r\n\r\n# Clients\r\nconnected_clients:5\r\n";
      const result = parseRedisInfo(raw);
      expect(result.server.redis_version).toBe("7.0.0");
      expect(result.server.redis_mode).toBe("standalone");
      expect(result.clients.connected_clients).toBe("5");
    });

    test("handles values with colons", () => {
      const raw = "# Server\r\nconfig_file:/etc/redis/redis.conf\r\n";
      const result = parseRedisInfo(raw);
      expect(result.server.config_file).toBe("/etc/redis/redis.conf");
    });
  });
});
