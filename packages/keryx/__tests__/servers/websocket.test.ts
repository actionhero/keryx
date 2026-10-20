import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { api } from "../../api";
import type { Action } from "../../classes/Action";
import { Channel } from "../../classes/Channel";
import { config } from "../../config";
import { buildWebSocket, serverUrl, useTestServer, waitFor } from "./../setup";

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

test("handler errors are caught by the surrounding try/catch", async () => {
  const { socket, messages } = await buildWebSocket();

  socket.send(
    JSON.stringify({
      messageType: "action",
      action: "nonexistent-action",
      messageId: 1,
      params: {},
    }),
  );

  while (messages.length === 0) await Bun.sleep(10);

  const response = JSON.parse(messages[0].data);
  expect(response.messageId).toBe(1);
  expect(response.error.message).toBe("Action not found: nonexistent-action");
  expect(response.error.type).toBe("CONNECTION_ACTION_NOT_FOUND");

  socket.close();
});

test("outer catch includes messageId for unknown messageType", async () => {
  const { socket, messages } = await buildWebSocket();

  socket.send(
    JSON.stringify({
      messageType: "bogus",
      messageId: 42,
    }),
  );

  while (messages.length === 0) await Bun.sleep(10);

  const response = JSON.parse(messages[0].data);
  expect(response.messageId).toBe(42);
  expect(response.error.type).toBe("CONNECTION_ACTION_RUN");
  expect(response.error.message).toContain(
    "messageType either missing or unknown",
  );

  socket.close();
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

describe("per-connection ordering of channel operations", () => {
  /** How long the slow channel's middleware stalls each subscribe, in ms. */
  const MIDDLEWARE_DELAY = 100;

  class SlowChannel extends Channel {
    constructor() {
      super({
        name: /^ordered-chan:.*$/,
        middleware: [
          {
            runBefore: async () => {
              await Bun.sleep(MIDDLEWARE_DELAY);
            },
          },
        ],
      });
    }
  }
  const slowChannel = new SlowChannel();

  const slowAction = {
    name: "test:ws-slow",
    inputs: z.object({}),
    timeout: 0,
    run: async () => {
      await Bun.sleep(MIDDLEWARE_DELAY * 3);
      return { slow: true };
    },
  } as unknown as Action;

  beforeAll(() => {
    api.channels.channels.push(slowChannel);
    api.actions.actions.push(slowAction);
  });

  afterAll(() => {
    const channelIdx = api.channels.channels.indexOf(slowChannel);
    if (channelIdx !== -1) api.channels.channels.splice(channelIdx, 1);
    const actionIdx = api.actions.actions.indexOf(slowAction);
    if (actionIdx !== -1) api.actions.actions.splice(actionIdx, 1);
  });

  /** Ack/response frames for our messageIds, in arrival order (presence broadcasts excluded). */
  const replies = (messages: MessageEvent[]) =>
    messages
      .map((m) => JSON.parse(m.data))
      .filter((m) => m.messageId !== undefined);

  test("subscribe then unsubscribe in one tick ends unsubscribed (#550)", async () => {
    const channel = `ordered-chan:${crypto.randomUUID()}`;
    const { socket, messages } = await buildWebSocket();

    socket.send(
      JSON.stringify({ messageType: "subscribe", channel, messageId: 1 }),
    );
    socket.send(
      JSON.stringify({ messageType: "unsubscribe", channel, messageId: 2 }),
    );

    await waitFor(() => replies(messages).length >= 2);
    const acks = replies(messages);
    expect(acks[0]).toEqual({ messageId: 1, subscribed: { channel } });
    expect(acks[1]).toEqual({ messageId: 2, unsubscribed: { channel } });

    await api.pubsub.broadcast(channel, "PING", "repro");
    await Bun.sleep(200);
    const pings = messages
      .map((m) => JSON.parse(m.data))
      .filter((m) => m.message?.message === "PING");
    expect(pings).toHaveLength(0);

    socket.close();
  });

  test("subscribe, unsubscribe, subscribe acks in send order and ends subscribed", async () => {
    const channel = `ordered-chan:${crypto.randomUUID()}`;
    const { socket, messages } = await buildWebSocket();

    socket.send(
      JSON.stringify({ messageType: "subscribe", channel, messageId: 1 }),
    );
    socket.send(
      JSON.stringify({ messageType: "unsubscribe", channel, messageId: 2 }),
    );
    socket.send(
      JSON.stringify({ messageType: "subscribe", channel, messageId: 3 }),
    );

    await waitFor(() => replies(messages).length >= 3);
    expect(replies(messages).map((m) => m.messageId)).toEqual([1, 2, 3]);

    await api.pubsub.broadcast(channel, "PING", "repro");
    await waitFor(() =>
      messages.some((m) => JSON.parse(m.data).message?.message === "PING"),
    );

    socket.close();
  });

  test("an action waits for channel operations sent before it", async () => {
    const channel = `ordered-chan:${crypto.randomUUID()}`;
    const { socket, messages } = await buildWebSocket();

    socket.send(
      JSON.stringify({ messageType: "subscribe", channel, messageId: 1 }),
    );
    socket.send(
      JSON.stringify({
        messageType: "action",
        action: "status",
        messageId: 2,
        params: {},
      }),
    );

    await waitFor(() => replies(messages).length >= 2);
    expect(replies(messages).map((m) => m.messageId)).toEqual([1, 2]);

    socket.close();
  });

  test("a slow action doesn't hold up later frames", async () => {
    const channel = `ordered-chan:${crypto.randomUUID()}`;
    const { socket, messages } = await buildWebSocket();

    socket.send(
      JSON.stringify({
        messageType: "action",
        action: "test:ws-slow",
        messageId: 1,
        params: {},
      }),
    );
    socket.send(
      JSON.stringify({ messageType: "subscribe", channel, messageId: 2 }),
    );

    await waitFor(() => replies(messages).length >= 2);
    const acks = replies(messages);
    expect(acks.map((m) => m.messageId)).toEqual([2, 1]);
    expect(acks[1].response).toEqual({ slow: true });

    socket.close();
  });
});
