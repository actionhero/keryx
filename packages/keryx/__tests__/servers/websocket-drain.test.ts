import { afterAll, beforeAll, expect, test } from "bun:test";
import { api } from "../../api";
import { config } from "../../config";
import type { WebServer } from "../../servers/web";
import { buildWebSocket, HOOK_TIMEOUT, serverUrl } from "./../setup";

beforeAll(async () => {
  await api.start();
  await api.db.clearDatabase();
}, HOOK_TIMEOUT);

afterAll(async () => {
  // Server may already be stopped by the drain test
  try {
    await api.stop();
  } catch (_e) {
    // ignore
  }
}, HOOK_TIMEOUT);

test("sends close frame with reason to WebSocket clients on shutdown", async () => {
  const { socket } = await buildWebSocket();

  // Verify the socket is open
  expect(socket.readyState).toBe(WebSocket.OPEN);

  // Track close event
  const closeEvent = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve);
  });

  // Use a short drain timeout for tests
  const originalTimeout = config.server.web.websocket.drainTimeout;
  (config.server.web.websocket as any).drainTimeout = 500;

  try {
    // Stop just the web server (not the full api, so other tests can still use shared resources)
    const web = api.servers.servers.find((s) => s.name === "web") as WebServer;
    await web.stop();

    const event = await closeEvent;
    // Bun's WebSocket client normalizes close codes to 1000, but the reason
    // string is propagated correctly. Browser clients will receive the actual
    // 1001 code. The server sends close(1001, "Server shutting down").
    expect(event.reason).toBe("Server shutting down");
  } finally {
    (config.server.web.websocket as any).drainTimeout = originalTimeout;
  }
});

test("cleans up all WebSocket connections on shutdown", async () => {
  // Restart the web server for this test
  const web = api.servers.servers.find((s) => s.name === "web") as WebServer;
  // @ts-expect-error reset private field for testing
  web.shuttingDown = false;
  await web.start();

  const { socket: _socket1 } = await buildWebSocket();
  const { socket: _socket2 } = await buildWebSocket();

  // Verify both are tracked
  const wsBefore = [...api.connections.connections.values()].filter(
    (c) => c.type === "websocket",
  );
  expect(wsBefore.length).toBe(2);

  const originalTimeout = config.server.web.websocket.drainTimeout;
  (config.server.web.websocket as any).drainTimeout = 500;

  try {
    await web.stop();

    // All WebSocket connections should be cleaned up
    const wsAfter = [...api.connections.connections.values()].filter(
      (c) => c.type === "websocket",
    );
    expect(wsAfter.length).toBe(0);
  } finally {
    (config.server.web.websocket as any).drainTimeout = originalTimeout;
  }
});

test("rejects new WebSocket upgrades during shutdown", async () => {
  const web = api.servers.servers.find((s) => s.name === "web") as WebServer;
  // @ts-expect-error reset private field for testing
  web.shuttingDown = false;
  await web.start();
  // @ts-expect-error set private field for testing
  web.shuttingDown = true;

  try {
    // Attempt a raw HTTP upgrade request - should get 503
    const res = await fetch(serverUrl(), {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": btoa(crypto.randomUUID()),
        "Sec-WebSocket-Version": "13",
      },
    });

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Server is shutting down");
  } finally {
    // @ts-expect-error reset private field for testing
    web.shuttingDown = false;
  }
});
