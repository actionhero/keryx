import { setMaxListeners } from "events";
import { api } from "keryx";

// Set max listeners to prevent warnings in CI environments
setMaxListeners(999);

// CI environments are slower; hooks need enough time for api.start()/api.stop()
export const HOOK_TIMEOUT = 15_000;

/**
 * Return the actual URL the web server bound to (resolved port).
 * Call after api.start() so the server has bound its port.
 */
export function serverUrl(): string {
  // Access web server URL via the api servers list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const web = api.servers?.servers?.find(
    (s: { name: string }) => s.name === "web",
  ) as { url?: string } | undefined;
  return web?.url || "";
}

// ioredis flushes its command queue on connection close, rejecting pending
// commands with "Connection is closed." These rejections are unhandled because
// they originate from fire-and-forget callers (e.g. node-resque's setInterval
// ping). This is harmless during test shutdown but causes bun:test to exit 1.
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
