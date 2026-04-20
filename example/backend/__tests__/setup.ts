import { setMaxListeners } from "events";
// Import from local index first to set api.rootDir before any framework code runs
import "../index";

export {
  buildWebSocket,
  createSession,
  createUser,
  HOOK_TIMEOUT,
  serverUrl,
  subscribeToChannel,
  useTestServer,
  waitFor,
  waitForBroadcastMessages,
} from "keryx/testing";

// Set max listeners to prevent warnings in CI environments
// TODO: Github Actions needs this, but not locally. Why?
setMaxListeners(999);

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
