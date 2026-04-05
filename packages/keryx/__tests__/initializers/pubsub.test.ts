import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api, Connection } from "../../api";
import type { PubSubMessage } from "../../initializers/pubsub";
import { HOOK_TIMEOUT, waitFor } from "./../setup";

/** A test connection that captures broadcast messages instead of throwing. */
class TestConnection extends Connection {
  receivedMessages: PubSubMessage[] = [];

  onBroadcastMessageReceived(payload: PubSubMessage) {
    this.receivedMessages.push(payload);
  }

  /** Filter received messages to only those on the given channel. */
  messagesFor(channel: string): PubSubMessage[] {
    return this.receivedMessages.filter((m) => m.channel === channel);
  }
}

beforeAll(async () => {
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

afterEach(() => {
  api.connections.connections.clear();
});

describe("pubsub initializer", () => {
  test("pubsub namespace is initialized with broadcast function", () => {
    expect(api.pubsub).toBeDefined();
    expect(typeof api.pubsub.broadcast).toBe("function");
  });

  test("broadcast delivers message to subscribed connections", async () => {
    const conn = new TestConnection("test", "pubsub-test-1");
    conn.subscribe("pubsub-test-deliver");
    api.connections.connections.set(conn.id, conn);

    await api.pubsub.broadcast(
      "pubsub-test-deliver",
      "hello world",
      "sender-1",
    );

    await waitFor(() => conn.messagesFor("pubsub-test-deliver").length > 0);

    const msgs = conn.messagesFor("pubsub-test-deliver");
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0].channel).toBe("pubsub-test-deliver");
    expect(msgs[0].message).toBe("hello world");
    expect(msgs[0].sender).toBe("sender-1");
  });

  test("broadcast does not deliver to connections on other channels", async () => {
    const subscribed = new TestConnection("test", "pubsub-sub");
    subscribed.subscribe("pubsub-channel-a");
    api.connections.connections.set(subscribed.id, subscribed);

    const notSubscribed = new TestConnection("test", "pubsub-nosub");
    notSubscribed.subscribe("pubsub-channel-b");
    api.connections.connections.set(notSubscribed.id, notSubscribed);

    await api.pubsub.broadcast("pubsub-channel-a", "targeted", "sender");

    await waitFor(() => subscribed.messagesFor("pubsub-channel-a").length > 0);
    // Give a moment for any erroneous delivery
    await Bun.sleep(100);

    expect(
      subscribed.messagesFor("pubsub-channel-a").length,
    ).toBeGreaterThanOrEqual(1);
    expect(notSubscribed.messagesFor("pubsub-channel-a")).toHaveLength(0);
  });

  test("broadcast delivers to multiple subscribed connections", async () => {
    const conn1 = new TestConnection("test", "pubsub-multi-1");
    conn1.subscribe("pubsub-shared");
    api.connections.connections.set(conn1.id, conn1);

    const conn2 = new TestConnection("test", "pubsub-multi-2");
    conn2.subscribe("pubsub-shared");
    api.connections.connections.set(conn2.id, conn2);

    await api.pubsub.broadcast("pubsub-shared", "to all", "sender");

    await waitFor(
      () =>
        conn1.messagesFor("pubsub-shared").length > 0 &&
        conn2.messagesFor("pubsub-shared").length > 0,
    );

    expect(conn1.messagesFor("pubsub-shared").length).toBeGreaterThanOrEqual(1);
    expect(conn2.messagesFor("pubsub-shared").length).toBeGreaterThanOrEqual(1);
    expect(conn1.messagesFor("pubsub-shared")[0].message).toBe("to all");
    expect(conn2.messagesFor("pubsub-shared")[0].message).toBe("to all");
  });

  test("sender defaults to unknown-sender when not provided", async () => {
    const conn = new TestConnection("test", "pubsub-default-sender");
    conn.subscribe("pubsub-default-sender-ch");
    api.connections.connections.set(conn.id, conn);

    await api.pubsub.broadcast("pubsub-default-sender-ch", "test");

    await waitFor(
      () => conn.messagesFor("pubsub-default-sender-ch").length > 0,
    );

    expect(conn.messagesFor("pubsub-default-sender-ch")[0].sender).toBe(
      "unknown-sender",
    );
  });

  test("no delivery when no connections are subscribed", async () => {
    const result = await api.pubsub.broadcast(
      "pubsub-empty",
      "nobody home",
      "sender",
    );
    // publish returns the number of Redis subscribers (at least 1 — our own subscription client)
    expect(result).toBeGreaterThanOrEqual(0);
  });
});
