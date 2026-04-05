import { sql } from "drizzle-orm";
import { z } from "zod";
import { Action, api } from "../api";
import { HTTP_METHOD } from "../classes/Action";
import packageJSON from "../package.json";

export class Status implements Action {
  name = "status";
  description =
    "Returns server health and runtime information including the server name, process ID, package version, uptime in milliseconds, memory consumption in MB, and dependency health checks for the database and Redis. Does not require authentication.";
  inputs = z.object({});
  web = { route: "/status", method: HTTP_METHOD.GET };

  async run() {
    const consumedMemoryMB =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;

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

    const healthy = databaseHealthy && redisHealthy;

    return {
      name: api.process.name,
      pid: api.process.pid,
      version: packageJSON.version,
      uptime: new Date().getTime() - api.bootTime,
      consumedMemoryMB,
      healthy,
      checks: {
        database: databaseHealthy,
        redis: redisHealthy,
      },
    };
  }
}
