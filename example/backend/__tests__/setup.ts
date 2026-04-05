import { setMaxListeners } from "events";
// Import from local index first to set api.rootDir before any framework code runs
import { api, type WebServer } from "keryx";
import "../index";

// Set max listeners to prevent warnings in CI environments
// TODO: Github Actions needs this, but not locally. Why?
setMaxListeners(999);

// CI environments are slower; hooks need enough time for api.start()/api.stop()
// which connect to Redis, Postgres, run migrations, etc.
// bun:test's setDefaultTimeout and bunfig.toml [test].timeout only apply to
// test() blocks, not lifecycle hooks — so we export this for explicit use.
export const HOOK_TIMEOUT = 15_000;

/**
 * Return the actual URL the web server bound to (resolved port).
 * Call after api.start() so the server has bound its port.
 */
export function serverUrl(): string {
  const web = api.servers.servers.find(
    (s: { name: string }) => s.name === "web",
  ) as WebServer | undefined;
  return web?.url || "";
}

/**
 * Poll a condition until it returns true, or throw after a timeout.
 * Use this instead of fixed Bun.sleep() calls when waiting for async side effects.
 */
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  { interval = 50, timeout = 5000 } = {},
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await Bun.sleep(interval);
  }
}

// ioredis flushes its command queue on connection close, rejecting pending
// commands with "Connection is closed." These rejections are unhandled because
// they originate from fire-and-forget callers (e.g. node-resque's setInterval
// ping). This is harmless during test shutdown but causes bun:test to exit 1.
// Note: ioredis uses plain Error objects with no custom class or error code,
// so we match the exact message string and verify the stack originates from ioredis.
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
