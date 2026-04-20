import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { api, Connection } from "../../api";
import type { PubSubMessage } from "../../initializers/pubsub";
import { useTestServer, waitFor } from "./../setup";

/** A test connection that captures broadcast messages. */
class TestConnection extends Connection {
  receivedMessages: PubSubMessage[] = [];

  onBroadcastMessageReceived(payload: PubSubMessage) {
    this.receivedMessages.push(payload);
  }
}

useTestServer();

beforeAll(async () => {
  await api.channels.clearPresence();
});

afterEach(async () => {
  api.connections.connections.clear();
  await api.channels.clearPresence();
});

describe("channels initializer", () => {
  test("channels namespace is initialized", () => {
    expect(api.channels).toBeDefined();
    expect(typeof api.channels.findChannel).toBe("function");
    expect(typeof api.channels.authorizeSubscription).toBe("function");
    expect(typeof api.channels.addPresence).toBe("function");
    expect(typeof api.channels.removePresence).toBe("function");
    expect(typeof api.channels.members).toBe("function");
    expect(typeof api.channels.clearPresence).toBe("function");
    expect(Array.isArray(api.channels.channels)).toBe(true);
  });

  test("findChannel returns undefined for unknown channel", () => {
    const result = api.channels.findChannel("nonexistent-channel");
    expect(result).toBeUndefined();
  });

  test("authorizeSubscription throws for unknown channel", async () => {
    const conn = new Connection("test", "auth-test");

    expect(
      api.channels.authorizeSubscription("nonexistent-channel", conn),
    ).rejects.toThrow("Channel not found");
  });

  describe("presence tracking", () => {
    test("addPresence tracks a connection and members returns it", async () => {
      const conn = new TestConnection("test", "presence-add");
      conn.subscribe("presence-test");
      api.connections.connections.set(conn.id, conn);

      await api.channels.addPresence("presence-test", conn);

      const membersList = await api.channels.members("presence-test");
      expect(membersList).toContain(conn.id);
    });

    test("removePresence removes a connection from presence", async () => {
      const conn = new TestConnection("test", "presence-remove");
      conn.subscribe("presence-rm-test");
      api.connections.connections.set(conn.id, conn);

      await api.channels.addPresence("presence-rm-test", conn);
      let membersList = await api.channels.members("presence-rm-test");
      expect(membersList).toContain(conn.id);

      await api.channels.removePresence("presence-rm-test", conn);
      membersList = await api.channels.members("presence-rm-test");
      expect(membersList).not.toContain(conn.id);
    });

    test("addPresence broadcasts join event on first connection for a key", async () => {
      const listener = new TestConnection("test", "join-listener");
      listener.subscribe("join-test");
      api.connections.connections.set(listener.id, listener);

      const joiner = new TestConnection("test", "joiner");
      joiner.subscribe("join-test");
      api.connections.connections.set(joiner.id, joiner);

      await api.channels.addPresence("join-test", joiner);

      await waitFor(() => listener.receivedMessages.length > 0);

      const joinMsg = listener.receivedMessages.find((m) => {
        const parsed = JSON.parse(m.message);
        return parsed.event === "join";
      });
      expect(joinMsg).toBeDefined();
      const parsed = JSON.parse(joinMsg!.message);
      expect(parsed.event).toBe("join");
      expect(parsed.presenceKey).toBe(joiner.id);
    });

    test("removePresence broadcasts leave event when last connection leaves", async () => {
      const listener = new TestConnection("test", "leave-listener");
      listener.subscribe("leave-test");
      api.connections.connections.set(listener.id, listener);

      const leaver = new TestConnection("test", "leaver");
      leaver.subscribe("leave-test");
      api.connections.connections.set(leaver.id, leaver);

      await api.channels.addPresence("leave-test", leaver);
      // Wait for the join event first
      await waitFor(() => listener.receivedMessages.length > 0);
      listener.receivedMessages = [];

      await api.channels.removePresence("leave-test", leaver);

      await waitFor(() => listener.receivedMessages.length > 0);

      const leaveMsg = listener.receivedMessages.find((m) => {
        const parsed = JSON.parse(m.message);
        return parsed.event === "leave";
      });
      expect(leaveMsg).toBeDefined();
      const parsed = JSON.parse(leaveMsg!.message);
      expect(parsed.event).toBe("leave");
      expect(parsed.presenceKey).toBe(leaver.id);
    });

    test("members returns empty array for channel with no presence", async () => {
      const membersList = await api.channels.members("empty-channel");
      expect(membersList).toEqual([]);
    });

    test("clearPresence removes all presence keys", async () => {
      const conn1 = new TestConnection("test", "clear-1");
      conn1.subscribe("clear-test-a");
      api.connections.connections.set(conn1.id, conn1);

      const conn2 = new TestConnection("test", "clear-2");
      conn2.subscribe("clear-test-b");
      api.connections.connections.set(conn2.id, conn2);

      await api.channels.addPresence("clear-test-a", conn1);
      await api.channels.addPresence("clear-test-b", conn2);

      let membersA = await api.channels.members("clear-test-a");
      let membersB = await api.channels.members("clear-test-b");
      expect(membersA.length).toBeGreaterThan(0);
      expect(membersB.length).toBeGreaterThan(0);

      await api.channels.clearPresence();

      membersA = await api.channels.members("clear-test-a");
      membersB = await api.channels.members("clear-test-b");
      expect(membersA).toEqual([]);
      expect(membersB).toEqual([]);
    });
  });
});
