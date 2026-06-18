import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "keryx";
import { HOOK_TIMEOUT, serverUrl } from "./../setup";

let wsUrl: string;

beforeAll(async () => {
  await api.start();
  wsUrl = serverUrl().replace("https://", "wss://").replace("http://", "ws://");
  await api.db.clearDatabase();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const buildWebSocket = async () => {
  const socket = new WebSocket(wsUrl);
  const messages: MessageEvent[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(event);
  });
  socket.addEventListener("error", (event) => {
    console.error(event);
  });
  await new Promise((resolve) => {
    socket.addEventListener("open", resolve);
  });
  return { socket, messages };
};

// Helper to wait for a specific number of messages
const waitForMessages = async (
  messages: MessageEvent[],
  count: number,
  timeout = 2000,
) => {
  const start = Date.now();
  while (messages.length < count && Date.now() - start < timeout) {
    await Bun.sleep(10);
  }
};

// Helper to wait for a message matching a specific messageId
const waitForMessageId = async (
  messages: MessageEvent[],
  messageId: string,
  timeout = 2000,
) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const m of messages) {
      const parsed = JSON.parse(m.data);
      if (parsed.messageId === messageId) return parsed;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for messageId "${messageId}"`);
};

describe("channel authorization", () => {
  beforeEach(async () => {
    await api.db.clearDatabase();
  });

  describe("protected channels", () => {
    test("should deny subscription to messages channel without authentication", async () => {
      const { socket, messages } = await buildWebSocket();

      // Try to subscribe without being logged in
      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          messageId: "sub-1",
          channel: "messages",
        }),
      );

      await waitForMessages(messages, 1);

      expect(messages.length).toBe(1);
      const response = JSON.parse(messages[0].data);
      expect(response.messageId).toBe("sub-1");
      expect(response.error).toBeDefined();
      expect(response.error.type).toBe("CONNECTION_CHANNEL_AUTHORIZATION");
      expect(response.error.message).toBe(
        "Authentication required to join this channel",
      );

      socket.close();
    });

    test("should allow subscription to messages channel after authentication", async () => {
      const { socket, messages } = await buildWebSocket();

      // Create a user
      socket.send(
        JSON.stringify({
          messageType: "action",
          action: "user:create",
          messageId: "create-user",
          params: {
            name: "Test User",
            email: "testuser@example.com",
            password: "password123",
          },
        }),
      );

      await waitForMessages(messages, 1);
      const createResponse = JSON.parse(messages[0].data);
      expect(createResponse.response.user.id).toBeGreaterThan(0);

      // Create a session (log in)
      socket.send(
        JSON.stringify({
          messageType: "action",
          action: "session:create",
          messageId: "create-session",
          params: {
            email: "testuser@example.com",
            password: "password123",
          },
        }),
      );

      await waitForMessages(messages, 2);
      const sessionResponse = JSON.parse(messages[1].data);
      expect(sessionResponse.response.session.data.userId).toBeGreaterThan(0);

      // Now try to subscribe - should succeed
      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          messageId: "sub-1",
          channel: "messages",
        }),
      );

      const subscribeResponse = await waitForMessageId(messages, "sub-1");
      expect(subscribeResponse.error).toBeUndefined();
      expect(subscribeResponse.subscribed).toEqual({ channel: "messages" });

      socket.close();
    });

    test("should allow unsubscription from protected channels", async () => {
      const { socket, messages } = await buildWebSocket();

      // Create user and session
      socket.send(
        JSON.stringify({
          messageType: "action",
          action: "user:create",
          messageId: "create-user",
          params: {
            name: "Test User",
            email: "unsubtest@example.com",
            password: "password123",
          },
        }),
      );
      await waitForMessages(messages, 1);

      socket.send(
        JSON.stringify({
          messageType: "action",
          action: "session:create",
          messageId: "create-session",
          params: {
            email: "unsubtest@example.com",
            password: "password123",
          },
        }),
      );
      await waitForMessages(messages, 2);

      // Subscribe to messages channel
      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          messageId: "sub-1",
          channel: "messages",
        }),
      );
      await waitForMessageId(messages, "sub-1");

      // Unsubscribe (presence broadcasts may add extra messages)
      socket.send(
        JSON.stringify({
          messageType: "unsubscribe",
          messageId: "unsub-1",
          channel: "messages",
        }),
      );
      await Bun.sleep(200);

      const unsubscribeResponse = messages
        .map((m) => JSON.parse(m.data))
        .find((m) => m.messageId === "unsub-1");
      expect(unsubscribeResponse).toBeDefined();
      expect(unsubscribeResponse.unsubscribed).toEqual({ channel: "messages" });

      socket.close();
    });
  });

  describe("undefined channels", () => {
    test("should deny subscription to channels without a Channel definition", async () => {
      const { socket, messages } = await buildWebSocket();

      // Try to subscribe to a channel that doesn't have a Channel definition
      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          messageId: "sub-1",
          channel: "public-announcements",
        }),
      );

      await waitForMessages(messages, 1);

      const response = JSON.parse(messages[0].data);
      expect(response.messageId).toBe("sub-1");
      expect(response.error).toBeDefined();
      expect(response.error.type).toBe("CONNECTION_CHANNEL_AUTHORIZATION");
      expect(response.error.message).toBe(
        "Channel not found: public-announcements",
      );

      socket.close();
    });
  });

  describe("channel name validation", () => {
    test("should reject empty channel name", async () => {
      const { socket, messages } = await buildWebSocket();

      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          messageId: "sub-1",
          channel: "",
        }),
      );

      await waitForMessages(messages, 1);

      const response = JSON.parse(messages[0].data);
      expect(response.messageId).toBe("sub-1");
      expect(response.error).toBeDefined();
      expect(response.error.type).toBe("CONNECTION_CHANNEL_VALIDATION");
      expect(response.error.message).toBe("Invalid channel name");

      socket.close();
    });

    test("should reject channel name over 200 characters", async () => {
      const { socket, messages } = await buildWebSocket();

      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          messageId: "sub-1",
          channel: "a".repeat(201),
        }),
      );

      await waitForMessages(messages, 1);

      const response = JSON.parse(messages[0].data);
      expect(response.error).toBeDefined();
      expect(response.error.type).toBe("CONNECTION_CHANNEL_VALIDATION");

      socket.close();
    });

    test("should reject channel name with spaces", async () => {
      const { socket, messages } = await buildWebSocket();

      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          messageId: "sub-1",
          channel: "bad channel name",
        }),
      );

      await waitForMessages(messages, 1);

      const response = JSON.parse(messages[0].data);
      expect(response.error).toBeDefined();
      expect(response.error.type).toBe("CONNECTION_CHANNEL_VALIDATION");

      socket.close();
    });

    test("should reject channel name with control characters", async () => {
      const { socket, messages } = await buildWebSocket();

      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          messageId: "sub-1",
          channel: "bad\x00channel",
        }),
      );

      await waitForMessages(messages, 1);

      const response = JSON.parse(messages[0].data);
      expect(response.error).toBeDefined();
      expect(response.error.type).toBe("CONNECTION_CHANNEL_VALIDATION");

      socket.close();
    });

    test("should reject channel name with unicode", async () => {
      const { socket, messages } = await buildWebSocket();

      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          messageId: "sub-1",
          channel: "channel-\u{1F600}",
        }),
      );

      await waitForMessages(messages, 1);

      const response = JSON.parse(messages[0].data);
      expect(response.error).toBeDefined();
      expect(response.error.type).toBe("CONNECTION_CHANNEL_VALIDATION");

      socket.close();
    });

    test("should reject valid channel names that have no Channel definition", async () => {
      const { socket, messages } = await buildWebSocket();

      socket.send(
        JSON.stringify({
          messageType: "subscribe",
          messageId: "sub-1",
          channel: "room:lobby.main-chat_v2",
        }),
      );

      await waitForMessages(messages, 1);

      const response = JSON.parse(messages[0].data);
      expect(response.messageId).toBe("sub-1");
      expect(response.error).toBeDefined();
      expect(response.error.type).toBe("CONNECTION_CHANNEL_AUTHORIZATION");
      expect(response.error.message).toBe(
        "Channel not found: room:lobby.main-chat_v2",
      );

      socket.close();
    });

    test("should reject invalid channel name on unsubscribe", async () => {
      const { socket, messages } = await buildWebSocket();

      socket.send(
        JSON.stringify({
          messageType: "unsubscribe",
          messageId: "unsub-1",
          channel: "bad channel!@#$",
        }),
      );

      await waitForMessages(messages, 1);

      const response = JSON.parse(messages[0].data);
      expect(response.error).toBeDefined();
      expect(response.error.type).toBe("CONNECTION_CHANNEL_VALIDATION");

      socket.close();
    });
  });

  describe("channel pattern matching", () => {
    test("should load channels initializer with registered channels", async () => {
      // Verify that the messages channel is loaded
      const messagesChannel = api.channels.findChannel("messages");
      expect(messagesChannel).toBeDefined();
      expect(messagesChannel?.name).toBe("messages");
      expect(messagesChannel?.middleware.length).toBeGreaterThan(0);
    });

    test("should return undefined for unregistered channels", async () => {
      const unknownChannel = api.channels.findChannel("unknown-channel-xyz");
      expect(unknownChannel).toBeUndefined();
    });
  });
});
