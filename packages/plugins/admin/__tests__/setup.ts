import { setMaxListeners } from "events";
import { api, type WebServer } from "keryx";

setMaxListeners(999);

export const HOOK_TIMEOUT = 15_000;

/**
 * Return the actual URL the web server bound to (resolved port).
 * Call after api.start() so the server has bound its port.
 */
export function serverUrl(): string {
  const web = api.servers.servers.find((s) => s.name === "web") as
    | WebServer
    | undefined;
  return web?.url || "";
}

// Suppress ioredis "Connection is closed." rejections during test shutdown
process.on("unhandledRejection", (reason: unknown) => {
  if (
    reason instanceof Error &&
    reason.message === "Connection is closed." &&
    reason.stack?.includes("ioredis")
  ) {
    return;
  }
  throw reason;
});
