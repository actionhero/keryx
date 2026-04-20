---
description: Testing with Bun's built-in test runner — real HTTP requests, no mocking.
---

# Testing

We don't mock the server. That's a deliberate choice — if you're testing an API, you should be making real HTTP requests against a real running server. Now that Bun includes `fetch` out of the box, this is trivially easy.

## Test Structure

Each test file boots and stops the full server in `beforeAll`/`afterAll`. Tests use dynamic port binding (`WEB_SERVER_PORT=0`) so each file gets a random available port — no conflicts when running multiple test files. Use the `useTestServer()` helper to register these hooks in one line:

```ts
import { useTestServer } from "keryx/testing";

const getUrl = useTestServer();

test("status endpoint returns server info", async () => {
  const res = await fetch(getUrl() + "/api/status");
  const body = (await res.json()) as ActionResponse<Status>;

  expect(res.status).toBe(200);
  expect(body.name).toBe("server");
  expect(body.uptime).toBeGreaterThan(0);
});
```

Yes, this means each test file starts the entire server — database connections, Redis, the works. It's slower than unit testing with mocks, but you're testing what actually happens when a client hits your API. I'll take that tradeoff every time.

## Test Helpers

The `keryx/testing` subpath exports helpers that cover the common test lifecycle:

- **`useTestServer(opts?)`** — Registers `beforeAll` / `afterAll` hooks that call `api.start()` and `api.stop()`. Returns a getter that resolves the server URL (the URL isn't known until the port is bound, so it's a function, not a string). Options:
  - `clearDatabase` (default `false`) — truncate all tables in `beforeAll` (requires the `db` initializer).
  - `clearRedis` (default `false`) — `FLUSHDB` on the current Redis database in `beforeAll` (requires the `redis` initializer). Opt in for tests that exercise pub/sub so messages from prior tests don't leak in.

  ```ts
  const getUrl = useTestServer({ clearDatabase: true, clearRedis: true });
  ```

  Need additional setup like inserting a seed user? Bun supports multiple `beforeAll` blocks per file — add another one after `useTestServer()` that runs once `api.start()` has completed.

- **`serverUrl()`** — Returns the actual URL the web server bound to (with resolved port). Call after `api.start()`. `useTestServer()` wraps this internally; reach for it directly only when you need manual lifecycle control.
- **`HOOK_TIMEOUT`** — A generous timeout (15s) for `beforeAll`/`afterAll` hooks, since they connect to Redis, Postgres, run migrations, etc. Pass as the second argument to `beforeAll`/`afterAll` when writing your own lifecycle hooks.
- **`buildWebSocket(opts?)`**, **`createUser`**, **`createSession`**, **`subscribeToChannel`**, **`waitForBroadcastMessages`** — Higher-level helpers for WebSocket tests. See [Testing WebSocket Connections](#testing-websocket-connections) below.
- **`waitFor(condition, { interval, timeout })`** — Polls a condition function until it returns `true`, or throws after a timeout. Use this instead of fixed `Bun.sleep()` calls when waiting for async side effects like background tasks:

```ts
await waitFor(
  async () => {
    const result = await db.query(
      "SELECT count(*) FROM jobs WHERE status = 'done'",
    );
    return result.count > 0;
  },
  { interval: 100, timeout: 5000 },
);
```

## Running Tests

```bash
# all backend tests
cd example/backend && bun test

# a single file
cd example/backend && bun test __tests__/actions/user.test.ts

# full CI — lint + test both frontend and backend
bun run ci
```

Tests run non-concurrently to avoid port conflicts. Each test file gets the server to itself.

## Making Requests

Just use `fetch`. Here's a typical test for creating a user:

```ts
test("create a user", async () => {
  const res = await fetch(getUrl() + "/api/user", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test User",
      email: "test@example.com",
      password: "password123",
    }),
  });

  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.user.name).toBe("Test User");
});
```

Nothing special — it's the same `fetch` you'd use in a browser or a Bun script.

## Database Setup

Tests typically clear the database before running to ensure a clean slate — pass `clearDatabase: true` to `useTestServer()`:

```ts
const getUrl = useTestServer({ clearDatabase: true });
```

`clearDatabase()` truncates all tables with `RESTART IDENTITY CASCADE`. It refuses to run when `NODE_ENV=production`, so you can't accidentally nuke your production data.

You'll need a separate test database:

```bash
createdb keryx-test
```

Set `DATABASE_URL_TEST` in your environment (or `backend/.env`) to point at it.

## Testing Authenticated Endpoints

Most endpoints require a session. The pattern is: create a user, log in, then pass the session cookie on subsequent requests:

```ts
import { config } from "keryx";

test("authenticated request", async () => {
  // Create a user
  await fetch(getUrl() + "/api/user", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test User",
      email: "test@example.com",
      password: "password123",
    }),
  });

  // Log in
  const sessionRes = await fetch(getUrl() + "/api/session", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test@example.com",
      password: "password123",
    }),
  });
  const sessionBody =
    (await sessionRes.json()) as ActionResponse<SessionCreate>;
  const sessionId = sessionBody.session.id;

  // Make an authenticated request
  const res = await fetch(getUrl() + "/api/user", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${config.session.cookieName}=${sessionId}`,
    },
    body: JSON.stringify({ name: "New Name" }),
  });

  expect(res.status).toBe(200);
});
```

The session ID comes from the login response, and you pass it as a `Cookie` header. This is the same cookie the browser would send automatically.

## Testing WebSocket Connections

WebSocket tests connect to the same server and send JSON messages. The lowest-level pattern looks like:

```ts
test("websocket action", async () => {
  const wsUrl = getUrl().replace("http", "ws");
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });

  const responsePromise = new Promise<any>((resolve) => {
    ws.onmessage = (event) => resolve(JSON.parse(event.data));
  });

  ws.send(
    JSON.stringify({
      messageType: "action",
      action: "status",
      messageId: "test-1",
    }),
  );

  const response = await responsePromise;
  expect(response.messageId).toBe("test-1");
  expect(response.name).toBe("server");

  ws.close();
});
```

For common flows — opening a socket, creating a user, logging in, subscribing to a channel, and collecting broadcasts — reach for the helpers exported from `keryx/testing`:

```ts
import {
  buildWebSocket,
  createSession,
  createUser,
  subscribeToChannel,
  waitForBroadcastMessages,
} from "keryx/testing";

test("broadcast reaches subscribers", async () => {
  const { socket, messages } = await buildWebSocket();
  await createUser(socket, messages, "Marco", "marco@example.com", "abc12345");
  await createSession(socket, messages, "marco@example.com", "abc12345");
  await subscribeToChannel(socket, messages, "messages");

  // ...trigger a broadcast...
  const broadcasts = await waitForBroadcastMessages(messages, 1);
  expect(broadcasts[0].message.body).toBe("hello");

  socket.close();
});
```

`buildWebSocket()` resolves once the socket's `open` event fires and exposes a live `messages` array that every subsequent handler populates. The action helpers assume the socket is fresh (they read from fixed indices in `messages`); `subscribeToChannel` matches the subscribe confirmation by content so it's resilient to presence broadcasts arriving out of order.

## Testing Background Tasks

Use `waitFor()` to poll for side effects from background tasks:

```ts
test("cleanup task removes old messages", async () => {
  // Insert test data...

  // Enqueue the task
  await api.actions.enqueue("messages:cleanup", { age: 1000 });

  // Wait for the side effect
  await waitFor(
    async () => {
      const remaining = await api.db.db.select().from(messages);
      return remaining.length === 0;
    },
    { interval: 100, timeout: 5000 },
  );
});
```

## Gotcha: Stale Processes

If you're changing code but your tests are still seeing old behavior… you probably have a stale server process running from a previous dev session. This has bitten me more than once:

```bash
ps aux | grep "bun keryx" | grep -v grep
kill -9 <PIDs>
```

Check for old processes whenever code changes aren't being reflected. It'll save you hours of debugging.
