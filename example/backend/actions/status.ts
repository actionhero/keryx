import { sql } from "drizzle-orm";
import { Action, api, HTTP_METHOD, MCP_RESPONSE_FORMAT } from "keryx";
import { z } from "zod";
import pkg from "../package.json";

async function checkDependencies() {
  let databaseHealthy = false;
  try {
    if (api.db?.db) {
      await api.db.db.execute(sql`SELECT NOW()`);
      databaseHealthy = true;
    }
  } catch {}

  let redisHealthy = false;
  try {
    if (api.redis?.redis) {
      await api.redis.redis.ping();
      redisHealthy = true;
    }
  } catch {}

  return {
    healthy: databaseHealthy && redisHealthy,
    checks: { database: databaseHealthy, redis: redisHealthy },
  };
}

export class Status implements Action {
  name = "status";
  description =
    "Returns server health and runtime information including the server name, process ID, package version, uptime in milliseconds, memory consumption in MB, and dependency health checks for the database and Redis. Does not require authentication.";
  inputs = z.object({});
  web = { route: "/status", method: HTTP_METHOD.GET };

  async run() {
    const consumedMemoryMB =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
    const { healthy, checks } = await checkDependencies();

    return {
      name: api.process.name,
      pid: api.process.pid,
      version: pkg.version,
      uptime: new Date().getTime() - api.bootTime,
      consumedMemoryMB,
      healthy,
      checks,
    };
  }
}

/**
 * Same as Status but configured to return markdown-formatted MCP responses.
 * Used for testing `mcp.responseFormat`.
 */
export class StatusMarkdown implements Action {
  name = "status:markdown";
  description = "Returns server status formatted as markdown.";
  inputs = z.object({});
  mcp = { responseFormat: MCP_RESPONSE_FORMAT.MARKDOWN };
  web = { route: "/status/markdown", method: HTTP_METHOD.GET };

  async run() {
    const consumedMemoryMB =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
    const { healthy, checks } = await checkDependencies();

    return {
      name: api.process.name,
      pid: api.process.pid,
      version: pkg.version,
      uptime: new Date().getTime() - api.bootTime,
      consumedMemoryMB,
      healthy,
      checks,
    };
  }
}
