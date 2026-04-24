import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

/**
 * Parse the raw Redis INFO string into structured sections.
 * Each section starts with `# SectionName` and contains `key:value` lines.
 */
export function parseRedisInfo(
  raw: string,
): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let currentSection = "general";

  for (const line of raw.split("\r\n")) {
    if (!line || line.length === 0) continue;

    if (line.startsWith("# ")) {
      currentSection = line.slice(2).toLowerCase();
      if (!sections[currentSection]) sections[currentSection] = {};
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1);

    if (!sections[currentSection]) sections[currentSection] = {};
    sections[currentSection][key] = value;
  }

  return sections;
}

export class ResqueAdminRedisInfo implements Action {
  name = "resque-admin:redis-info";
  description =
    "Returns parsed Redis INFO output organized by section (server, clients, memory, stats, etc.).";
  inputs = z.object({
    password: secret(z.string()),
  });
  web = { route: "/resque-admin/redis-info", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run() {
    const raw = await api.redis.redis.info();
    const sections = parseRedisInfo(raw);
    return { sections };
  }
}
