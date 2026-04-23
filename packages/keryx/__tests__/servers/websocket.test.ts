import { expect, test } from "bun:test";
import { api } from "../../api";
import { Channel } from "../../classes/Channel";
import { config } from "../../config";
import { buildWebSocket, serverUrl, useTestServer } from "./../setup";

useTestServer({ clearDatabase: true });

test("request to an action", async () => {
  const { socket, messages } = await buildWebSocket();

  socket.send(
    JSON.stringify({
      messageType: "action",
      action: "status",
      messageId: 1,
      params: {},
    }),
  );

  while (messages.length === 0) await Bun.sleep(10);

  expect(messages.length).toBe(1);
  const message = JSON.parse(messages[0].data);
  expect(message.messageId).toBe(1);
  expect(message.response.name).toBe("test-server");
  socket.close();
});

test("unknown actions", async () => {
  const { socket, messages } = await buildWebSocket();

  socket.send(
    JSON.stringify({
      messageType: "action",
      action: "unknown",
      messageId: 1,
      params: {},
    }),
  );

  while (messages.length === 0) await Bun.sleep(10);

  expect(messages.length).toBe(1);
  const message = JSON.parse(messages[0].data);
  expect(message.messageId).toBe(1);
  expect(message.error.message).toBe("Action not found: unknown");
  expect(message.error.type).toBe("CONNECTION_ACTION_NOT_FOUND");
  socket.close();
});

test("rate limits rapid messages", async () => {
  const originalLimit = config.server.web.websocket.maxMessagesPerSecond;
  (config.server.web.websocket as any).maxMessagesPerSecond = 3;

  try {
    const { socket, messages } = await buildWebSocket();

    // Send 5 messages in quick succession (limit is 3)
    for (let i = 0; i < 5; i++) {
      socket.send(
        JSON.stringify({
          messageType: "action",
          action: "status",
          messageId: i,
          params: {},
        }),
      );
    }

    // Wait for responses
    while (messages.length < 5) await Bun.sleep(10);

    const parsed = messages.map((m) => JSON.parse(m.data));
    const rateLimited = parsed.filter(
      (m: any) => m.error?.type === "CONNECTION_RATE_LIMITED",
    );
    expect(rateLimited.length).toBeGreaterThan(0);
    expect(rateLimited[0].error.message).toBe("WebSocket rate limit exceeded");

    socket.close();
  } finally {
    (config.server.web.websocket as any).maxMessagesPerSecond = originalLimit;
  }
});

test("limits max subscriptions per connection", async () => {
  const originalLimit = config.server.web.websocket.maxSubscriptions;
  (config.server.web.websocket as any).maxSubscriptions = 2;

  // Register temporary test channels so they pass authorization
  class TestChannel extends Channel {
    constructor(name: string) {
      super({ name });
    }
  }
  const testChannels = [
    new TestChannel("test-chan-0"),
    new TestChannel("test-chan-1"),
    new TestChannel("test-chan-overflow"),
  ];
  api.channels.channels.push(...testChannels);

  try {
    const { socket, messages } = await buildWebSocket();

    // Subscribe to 2 channels (the limit)
    for (let i = 0; i < 2; i++) {
      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          channel: `test-chan-${i}`,
          messageId: i,
        }),
      );
    }

    while (messages.length < 2) await Bun.sleep(10);

    // Third subscription should fail
    socket.send(
      JSON.stringify({
        messageType: "subscribe",
        channel: "test-chan-overflow",
        messageId: 99,
      }),
    );

    // Wait for the error response (presence broadcast events may interleave)
    let errorMsg: any;
    while (!errorMsg) {
      for (const m of messages) {
        const parsed = JSON.parse(m.data);
        if (parsed.error?.type === "CONNECTION_CHANNEL_VALIDATION") {
          errorMsg = parsed;
          break;
        }
      }
      if (!errorMsg) await Bun.sleep(10);
    }

    expect(errorMsg.error.type).toBe("CONNECTION_CHANNEL_VALIDATION");
    expect(errorMsg.error.message).toContain("Too many subscriptions");

    socket.close();
  } finally {
    (config.server.web.websocket as any).maxSubscriptions = originalLimit;
    // Remove temporary test channels
    for (const tc of testChannels) {
      const idx = api.channels.channels.indexOf(tc);
      if (idx !== -1) api.channels.channels.splice(idx, 1);
    }
  }
});

test("rejects subscribe with disallowed characters in channel name", async () => {
  const { socket, messages } = await buildWebSocket();

  socket.send(
    JSON.stringify({
      messageType: "subscribe",
      channel: "bad channel!",
      messageId: 1,
    }),
  );

  let errorMsg: any;
  while (!errorMsg) {
    for (const m of messages) {
      const parsed = JSON.parse(m.data);
      if (parsed.error?.type === "CONNECTION_CHANNEL_VALIDATION") {
        errorMsg = parsed;
        break;
      }
    }
    if (!errorMsg) await Bun.sleep(10);
  }

  expect(errorMsg.messageId).toBe(1);
  expect(errorMsg.error.type).toBe("CONNECTION_CHANNEL_VALIDATION");
  expect(errorMsg.error.message).toBe("Invalid channel name");
  expect(typeof errorMsg.error.timestamp).toBe("number");
  expect(errorMsg.error.timestamp).toBeGreaterThan(0);
  expect(errorMsg.error.key).toBeUndefined();
  expect(errorMsg.error.value).toBeUndefined();

  socket.close();
});

test("rejects subscribe with empty channel name", async () => {
  const { socket, messages } = await buildWebSocket();

  socket.send(
    JSON.stringify({
      messageType: "subscribe",
      channel: "",
      messageId: 2,
    }),
  );

  let errorMsg: any;
  while (!errorMsg) {
    for (const m of messages) {
      const parsed = JSON.parse(m.data);
      if (parsed.error?.type === "CONNECTION_CHANNEL_VALIDATION") {
        errorMsg = parsed;
        break;
      }
    }
    if (!errorMsg) await Bun.sleep(10);
  }

  expect(errorMsg.messageId).toBe(2);
  expect(errorMsg.error.type).toBe("CONNECTION_CHANNEL_VALIDATION");
  expect(errorMsg.error.message).toBe("Invalid channel name");
  expect(typeof errorMsg.error.timestamp).toBe("number");
  expect(errorMsg.error.timestamp).toBeGreaterThan(0);
  expect(errorMsg.error.key).toBeUndefined();
  expect(errorMsg.error.value).toBeUndefined();

  socket.close();
});

test("rejects subscribe with oversized channel name", async () => {
  const { socket, messages } = await buildWebSocket();

  socket.send(
    JSON.stringify({
      messageType: "subscribe",
      channel: "a".repeat(201),
      messageId: 3,
    }),
  );

  let errorMsg: any;
  while (!errorMsg) {
    for (const m of messages) {
      const parsed = JSON.parse(m.data);
      if (parsed.error?.type === "CONNECTION_CHANNEL_VALIDATION") {
        errorMsg = parsed;
        break;
      }
    }
    if (!errorMsg) await Bun.sleep(10);
  }

  expect(errorMsg.messageId).toBe(3);
  expect(errorMsg.error.type).toBe("CONNECTION_CHANNEL_VALIDATION");
  expect(errorMsg.error.message).toBe("Invalid channel name");
  expect(typeof errorMsg.error.timestamp).toBe("number");
  expect(errorMsg.error.timestamp).toBeGreaterThan(0);
  expect(errorMsg.error.key).toBeUndefined();
  expect(errorMsg.error.value).toBeUndefined();

  socket.close();
});

test("WebSocket connection survives concurrent HTTP requests", async () => {
  const { socket, messages } = await buildWebSocket();

  // Send a WebSocket action to confirm it works
  socket.send(
    JSON.stringify({
      messageType: "action",
      action: "status",
      messageId: 1,
      params: {},
    }),
  );
  while (messages.length === 0) await Bun.sleep(10);
  expect(JSON.parse(messages[0].data).response.name).toBe("test-server");

  // Make concurrent HTTP requests (simulates what the frontend ChatPage does
  // when it fetches messages via REST while the WebSocket is open)
  await Promise.all([
    fetch(serverUrl() + "/api/status"),
    fetch(serverUrl() + "/api/status"),
    fetch(serverUrl() + "/api/status"),
  ]);

  // WebSocket should still work after the HTTP requests complete
  socket.send(
    JSON.stringify({
      messageType: "action",
      action: "status",
      messageId: 2,
      params: {},
    }),
  );

  while (messages.length < 2) await Bun.sleep(10);
  const secondResponse = JSON.parse(messages[1].data);
  expect(secondResponse.messageId).toBe(2);
  expect(secondResponse.response.name).toBe("test-server");
  expect(secondResponse.error).toBeUndefined();

  socket.close();
});

test("rejects WebSocket upgrade with disallowed Origin header", async () => {
  const originalOrigins = config.server.web.allowedOrigins;
  (config.server.web as any).allowedOrigins = "http://allowed.example.com";

  try {
    const res = await fetch(serverUrl(), {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        Origin: "http://evil.example.com",
        "Sec-WebSocket-Key": btoa(crypto.randomUUID()),
        "Sec-WebSocket-Version": "13",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("WebSocket origin not allowed");
  } finally {
    (config.server.web as any).allowedOrigins = originalOrigins;
  }
});

test("allows WebSocket upgrade with matching Origin header", async () => {
  const originalOrigins = config.server.web.allowedOrigins;
  (config.server.web as any).allowedOrigins = serverUrl();

  try {
    const { socket } = await buildWebSocket({
      headers: { Origin: serverUrl() },
    });

    socket.send(
      JSON.stringify({
        messageType: "action",
        action: "status",
        messageId: 1,
        params: {},
      }),
    );

    socket.close();
  } finally {
    (config.server.web as any).allowedOrigins = originalOrigins;
  }
});

test("allows WebSocket upgrade with wildcard allowedOrigins", async () => {
  const originalOrigins = config.server.web.allowedOrigins;
  (config.server.web as any).allowedOrigins = "*";

  try {
    const { socket } = await buildWebSocket({
      headers: { Origin: "http://any-origin.example.com" },
    });

    socket.send(
      JSON.stringify({
        messageType: "action",
        action: "status",
        messageId: 1,
        params: {},
      }),
    );

    socket.close();
  } finally {
    (config.server.web as any).allowedOrigins = originalOrigins;
  }
});
