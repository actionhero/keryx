import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { api, config } from "keryx";
import {
  buildWebSocket,
  createSession,
  createUser,
  subscribeToChannel,
} from "../../../../packages/keryx/__tests__/servers/websocket-helpers";
import { HOOK_TIMEOUT } from "./../setup";

const originalRateLimitEnabled = config.rateLimit.enabled;

beforeAll(async () => {
  (config.rateLimit as any).enabled = false;
  await api.start();
  await api.db.clearDatabase();
}, HOOK_TIMEOUT);

afterAll(async () => {
  (config.rateLimit as any).enabled = originalRateLimitEnabled;
  await api.stop();
}, HOOK_TIMEOUT);

beforeEach(async () => {
  await api.db.clearDatabase();
  await api.channels.clearPresence();
});

test("should track presence when subscribing to a channel", async () => {
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

  // Subscribe first user
  await subscribeToChannel(socket1, messages1, "messages");
  let members = await api.channels.members("messages");
  expect(members.length).toBe(1);

  // Subscribe second user
  await subscribeToChannel(socket2, messages2, "messages");
  members = await api.channels.members("messages");
  expect(members.length).toBe(2);

  socket1.close();
  socket2.close();
  await Bun.sleep(100);
});

test("should remove presence on unsubscribe", async () => {
  const { socket, messages } = await buildWebSocket();

  await createUser(socket, messages, "Marco", "marco@example.com", "abc12345");
  await createSession(socket, messages, "marco@example.com", "abc12345");
  await subscribeToChannel(socket, messages, "messages");

  expect((await api.channels.members("messages")).length).toBe(1);

  // Unsubscribe
  socket.send(
    JSON.stringify({ messageType: "unsubscribe", channel: "messages" }),
  );
  await Bun.sleep(100);

  expect((await api.channels.members("messages")).length).toBe(0);

  socket.close();
  await Bun.sleep(100);
});

test("should remove presence on disconnect", async () => {
  const { socket, messages } = await buildWebSocket();

  await createUser(socket, messages, "Marco", "marco@example.com", "abc12345");
  await createSession(socket, messages, "marco@example.com", "abc12345");
  await subscribeToChannel(socket, messages, "messages");

  expect((await api.channels.members("messages")).length).toBe(1);

  // Close the socket (disconnect)
  socket.close();
  await Bun.sleep(100);

  expect((await api.channels.members("messages")).length).toBe(0);
});

test("should use presenceKey from channel (user ID for messages channel)", async () => {
  const { socket: socket1, messages: messages1 } = await buildWebSocket();
  const { socket: socket2, messages: messages2 } = await buildWebSocket();

  // Create the user via socket1
  await createUser(
    socket1,
    messages1,
    "Marco",
    "marco@example.com",
    "abc12345",
  );
  await createSession(socket1, messages1, "marco@example.com", "abc12345");
  await subscribeToChannel(socket1, messages1, "messages");

  // Socket2 logs in as the same user (second tab)
  socket2.send(
    JSON.stringify({
      messageType: "action",
      action: "session:create",
      messageId: 1,
      params: { email: "marco@example.com", password: "abc12345" },
    }),
  );
  while (messages2.length < 1) await Bun.sleep(10);

  socket2.send(
    JSON.stringify({
      messageType: "subscribe",
      channel: "messages",
    }),
  );
  while (messages2.length < 2) await Bun.sleep(10);

  // Same user = same presenceKey, so only 1 member
  const members = await api.channels.members("messages");
  expect(members.length).toBe(1);
  expect(members[0]).toBe("1"); // userId as string

  // Close first tab — user still present via second tab
  socket1.close();
  await Bun.sleep(100);
  expect((await api.channels.members("messages")).length).toBe(1);

  // Close second tab — now fully gone
  socket2.close();
  await Bun.sleep(100);
  expect((await api.channels.members("messages")).length).toBe(0);
});

test("should expire orphaned presence keys after TTL", async () => {
  // Use a very short TTL for this test
  const originalTTL = config.channels.presenceTTL;
  (config.channels as any).presenceTTL = 2;

  const { socket, messages } = await buildWebSocket();

  await createUser(socket, messages, "Marco", "marco@example.com", "abc12345");
  await createSession(socket, messages, "marco@example.com", "abc12345");
  await subscribeToChannel(socket, messages, "messages");

  expect((await api.channels.members("messages")).length).toBe(1);

  // Verify the Redis keys have a TTL set
  const ttl = await api.redis.redis.ttl("presence:messages");
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(2);

  // Simulate a crash by NOT calling removePresence — just clear all
  // connections so the heartbeat won't refresh their keys
  const savedConnections = new Map(api.connections.connections);
  api.connections.connections.clear();

  // Presence should still exist immediately
  expect((await api.channels.members("messages")).length).toBe(1);

  // Wait for TTL to expire
  await Bun.sleep(3000);

  // Now the orphaned presence should be gone
  expect((await api.channels.members("messages")).length).toBe(0);

  // Restore connections so cleanup can proceed, then close
  for (const [id, conn] of savedConnections) {
    api.connections.connections.set(id, conn);
  }
  (config.channels as any).presenceTTL = originalTTL;
  socket.close();
  await Bun.sleep(100);
});

test("should refresh presence TTL via heartbeat", async () => {
  const { socket, messages } = await buildWebSocket();

  await createUser(socket, messages, "Marco", "marco@example.com", "abc12345");
  await createSession(socket, messages, "marco@example.com", "abc12345");
  await subscribeToChannel(socket, messages, "messages");

  // Manually trigger a heartbeat refresh
  await api.channels.refreshPresence();

  // Verify presence keys still exist with TTLs
  const ttl = await api.redis.redis.ttl("presence:messages");
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(config.channels.presenceTTL);

  expect((await api.channels.members("messages")).length).toBe(1);

  socket.close();
  await Bun.sleep(100);
});

test("should broadcast join/leave events to other subscribers", async () => {
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

  // User 1 subscribes first
  await subscribeToChannel(socket1, messages1, "messages");

  // Record the baseline so we only inspect messages arriving after this point
  const baselineIndex = messages1.length;

  // User 2 subscribes — user 1 should receive a join event for presenceKey "2"
  await subscribeToChannel(socket2, messages2, "messages");
  await Bun.sleep(200);

  const findPresenceEvents = (
    msgs: MessageEvent[],
    startIndex: number,
    eventType: string,
    presenceKey: string,
  ) =>
    msgs.slice(startIndex).filter((m) => {
      try {
        const outer = JSON.parse(m.data);
        const parsed = JSON.parse(outer.message?.message);
        return parsed.event === eventType && parsed.presenceKey === presenceKey;
      } catch {
        return false;
      }
    });

  const joinEvents = findPresenceEvents(messages1, baselineIndex, "join", "2");
  expect(joinEvents.length).toBeGreaterThanOrEqual(1);

  // User 2 disconnects — user 1 should receive a leave event for presenceKey "2"
  const preLeaveIndex = messages1.length;
  socket2.close();
  await Bun.sleep(200);

  const leaveEvents = findPresenceEvents(
    messages1,
    preLeaveIndex,
    "leave",
    "2",
  );
  expect(leaveEvents.length).toBeGreaterThanOrEqual(1);

  socket1.close();
  await Bun.sleep(100);
});
