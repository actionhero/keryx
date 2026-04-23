import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { api, config } from "keryx";
import {
  buildWebSocket,
  createSession,
  createUser,
  subscribeToChannel,
  useTestServer,
  waitForBroadcastMessages,
} from "./../setup";

const originalRateLimitEnabled = config.rateLimit.enabled;

beforeAll(() => {
  (config.rateLimit as any).enabled = false;
});

useTestServer({ clearDatabase: true });

afterAll(() => {
  (config.rateLimit as any).enabled = originalRateLimitEnabled;
});

beforeEach(async () => {
  await api.db.clearDatabase();
});

test("should create two users with different IDs", async () => {
  const { socket: socket1, messages: messages1 } = await buildWebSocket();
  const { socket: socket2, messages: messages2 } = await buildWebSocket();

  const user1 = await createUser(
    socket1,
    messages1,
    "Marco",
    "marco@example.com",
    "abc12345",
  );
  const user2 = await createUser(
    socket2,
    messages2,
    "Polo",
    "polo@example.com",
    "abc12345",
  );

  expect(user1.id).toBeGreaterThan(0);
  expect(user2.id).toBeGreaterThan(0);
  expect(user1.id).not.toBe(user2.id);
  expect(user1.email).toBe("marco@example.com");
  expect(user2.email).toBe("polo@example.com");

  socket1.close();
  socket2.close();
});

test("should create sessions for both users", async () => {
  const { socket: socket1, messages: messages1 } = await buildWebSocket();
  const { socket: socket2, messages: messages2 } = await buildWebSocket();

  await createUser(
    socket1,
    messages1,
    "Marco",
    "marco@example.com",
    "abc12345",
  );
  await createUser(socket2, messages2, "Polo", "polo@example.com", "abc12345");

  const session1 = await createSession(
    socket1,
    messages1,
    "marco@example.com",
    "abc12345",
  );
  const session2 = await createSession(
    socket2,
    messages2,
    "polo@example.com",
    "abc12345",
  );

  expect(session1.user.id).toBe(1);
  expect(session1.user.email).toBe("marco@example.com");
  expect(session1.session.data.userId).toBe(1);
  expect(session2.user.id).toBe(2);
  expect(session2.user.email).toBe("polo@example.com");
  expect(session2.session.data.userId).toBe(2);

  socket1.close();
  socket2.close();
});

test("should subscribe both users to messages channel", async () => {
  const { socket: socket1, messages: messages1 } = await buildWebSocket();
  const { socket: socket2, messages: messages2 } = await buildWebSocket();

  await createUser(
    socket1,
    messages1,
    "Marco",
    "marco@example.com",
    "abc12345",
  );
  await createUser(socket2, messages2, "Polo", "polo@example.com", "abc12345");
  await createSession(socket1, messages1, "marco@example.com", "abc12345");
  await createSession(socket2, messages2, "polo@example.com", "abc12345");

  const subscribe1 = await subscribeToChannel(socket1, messages1, "messages");
  const subscribe2 = await subscribeToChannel(socket2, messages2, "messages");

  expect(subscribe1).toEqual({ subscribed: { channel: "messages" } });
  expect(subscribe2).toEqual({ subscribed: { channel: "messages" } });

  socket1.close();
  socket2.close();
});

test.skipIf(Bun.env.GITHUB_ACTIONS === "true")(
  "should broadcast messages to all subscribed users",
  async () => {
    const { socket: socket1, messages: messages1 } = await buildWebSocket();
    const { socket: socket2, messages: messages2 } = await buildWebSocket();

    await createUser(
      socket1,
      messages1,
      "Marco",
      "marco@example.com",
      "abc12345",
    );
    await createUser(
      socket2,
      messages2,
      "Polo",
      "polo@example.com",
      "abc12345",
    );
    await createSession(socket1, messages1, "marco@example.com", "abc12345");
    await createSession(socket2, messages2, "polo@example.com", "abc12345");
    await subscribeToChannel(socket1, messages1, "messages");
    await subscribeToChannel(socket2, messages2, "messages");

    // Clear action response messages
    while (messages1.length > 0) messages1.pop();
    while (messages2.length > 0) messages2.pop();

    // Send messages
    socket1.send(
      JSON.stringify({
        messageType: "action",
        action: "message:create",
        messageId: "A",
        params: { body: "Marco" },
      }),
    );

    socket2.send(
      JSON.stringify({
        messageType: "action",
        action: "message:create",
        messageId: "B",
        params: { body: "Polo" },
      }),
    );

    const broadcastMessages1 = await waitForBroadcastMessages(messages1, 2);
    const broadcastMessages2 = await waitForBroadcastMessages(messages2, 2);

    // Verify both users received both messages
    const messageBodies1 = broadcastMessages1.map(
      (msg) => msg.message.message.message.body,
    );
    const messageBodies2 = broadcastMessages2.map(
      (msg) => msg.message.message.message.body,
    );
    expect(messageBodies1).toEqual(["Marco", "Polo"]);
    expect(messageBodies2).toEqual(["Marco", "Polo"]);

    socket1.close();
    socket2.close();
  },
);
