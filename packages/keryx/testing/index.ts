import { afterAll, beforeAll } from "bun:test";
import { api } from "../api";
import type { WebServer } from "../servers/web";

export {
  buildWebSocket,
  createSession,
  createUser,
  subscribeToChannel,
  waitForBroadcastMessages,
} from "./websocket";

/**
 * Generous lifecycle hook timeout (15s) for `beforeAll` / `afterAll`.
 *
 * `api.start()` and `api.stop()` connect to Redis, Postgres, run migrations,
 * etc. — slower than a unit test, especially in CI. Pass this as the second
 * argument to `beforeAll` / `afterAll` so hooks don't time out.
 *
 * Note: `bun:test`'s `setDefaultTimeout` and `bunfig.toml [test].timeout` only
 * apply to `test()` blocks, not lifecycle hooks.
 */
export const HOOK_TIMEOUT = 15_000;

/**
 * Return the actual URL the web server bound to (with resolved port).
 * Returns an empty string if the web server isn't running.
 *
 * Call after `api.start()` so the server has bound its port. Useful when
 * `WEB_SERVER_PORT=0` is set so each test file gets a random available port.
 */
export function serverUrl(): string {
  const web = api.servers.servers.find(
    (s: { name: string }) => s.name === "web",
  ) as WebServer | undefined;
  return web?.url || "";
}

/**
 * Register `beforeAll` / `afterAll` hooks that start and stop the API around
 * a test file. Returns a getter for the bound server URL — the URL isn't known
 * until after `api.start()` binds the port, so it can't be returned directly.
 *
 * **Hook ordering gotcha.** `bun:test` runs `beforeAll` and `afterAll` hooks in
 * registration order (not LIFO). So whichever hook is registered first runs
 * first — in both phases. This matters in two ways:
 *
 * 1. **Config overrides that must happen before `api.start()`** — register a
 *    separate `beforeAll` that sets the config *before* calling `useTestServer()`,
 *    so it runs first.
 * 2. **Teardown cleanup that needs Redis/DB access** — the helper's `afterAll`
 *    calls `api.stop()`, which closes the Redis and Postgres connections. Any
 *    cleanup that touches those must run *before* `api.stop()`. Since `afterAll`
 *    also runs in registration order, the helper's `api.stop()` runs first. Put
 *    connection-dependent cleanup in the same `afterAll` block as the original
 *    start/stop pair rather than splitting it, or handle cleanup in `afterEach`.
 *
 * @param opts.clearDatabase - Truncate all tables in `beforeAll`. Default `false`.
 *   Requires the `db` initializer to be active. Opt in for tests that mutate
 *   persistent state.
 * @param opts.clearRedis - Flush the current Redis DB in `beforeAll`. Default
 *   `false`. Requires the `redis` initializer to be active. Opt in for tests
 *   that exercise pub/sub so messages from prior tests don't leak in.
 * @returns A getter function that returns the server URL once `api.start()` has
 *   bound its port. Call the getter at each fetch site: `fetch(getUrl() + "/api/...")`.
 *
 * @example
 * const getUrl = useTestServer({ clearDatabase: true });
 *
 * test("creates a user", async () => {
 *   const res = await fetch(getUrl() + "/api/user", { method: "PUT", ... });
 *   expect(res.status).toBe(200);
 * });
 */
export function useTestServer(
  opts: { clearDatabase?: boolean; clearRedis?: boolean } = {},
): () => string {
  const { clearDatabase = false, clearRedis = false } = opts;
  let url = "";
  beforeAll(async () => {
    await api.start();
    url = serverUrl();
    if (clearDatabase) await api.db.clearDatabase();
    if (clearRedis) await api.redis.redis.flushdb();
  }, HOOK_TIMEOUT);
  afterAll(async () => {
    await api.stop();
  }, HOOK_TIMEOUT);
  return () => url;
}

/**
 * Poll a condition until it returns true, or throw after a timeout.
 *
 * Use this instead of fixed `Bun.sleep()` calls when waiting for async side
 * effects like background tasks, pub/sub delivery, or presence updates.
 *
 * @param condition - Function returning a boolean (or Promise of one). Polled
 *   repeatedly until it returns truthy.
 * @param opts.interval - Milliseconds between polls. Default 50.
 * @param opts.timeout - Milliseconds before giving up. Default 5000.
 * @throws {Error} If the condition doesn't become truthy before the timeout.
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
