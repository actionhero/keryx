import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, Connection } from "../../api";
import { config } from "../../config";
import { HOOK_TIMEOUT } from "./../setup";

beforeAll(async () => {
  await api.start();
  await api.redis.redis.flushdb();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("session initializer", () => {
  test("session object is initialized", () => {
    expect(api.session).toBeDefined();
    expect(typeof api.session.create).toBe("function");
    expect(typeof api.session.load).toBe("function");
    expect(typeof api.session.update).toBe("function");
    expect(typeof api.session.destroy).toBe("function");
  });

  test("create stores session in Redis with correct structure", async () => {
    const connection = new Connection("test", "test-create");
    const sessionData = { userId: 123, username: "testuser" };

    const session = await api.session.create(connection, sessionData);

    expect(session.id).toBe(connection.id);
    expect(session.cookieName).toBe(config.session.cookieName);
    expect(session.createdAt).toBeDefined();
    expect(typeof session.createdAt).toBe("number");
    expect(session.data).toEqual(sessionData);
  });

  test("create sets TTL in Redis", async () => {
    const connection = new Connection("test", "test-ttl");
    const sessionData = { userId: 456 };

    await api.session.create(connection, sessionData);

    // Check TTL in Redis
    const ttl = await api.redis.redis.ttl(`session:${connection.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(config.session.ttl);
  });

  test("load retrieves session from Redis", async () => {
    const connection = new Connection("test", "test-load");
    const sessionData = { userId: 789, role: "admin" };

    // Create session
    await api.session.create(connection, sessionData);

    // Load session
    const loadedSession = await api.session.load(connection);

    expect(loadedSession).toBeDefined();
    expect(loadedSession?.id).toBe(connection.id);
    expect(loadedSession?.data).toEqual(sessionData);
  });

  test("load returns null for non-existent session", async () => {
    const connection = new Connection("test", "test-nonexistent");

    const loadedSession = await api.session.load(connection);

    expect(loadedSession).toBeNull();
  });

  test("load renews TTL on access", async () => {
    const connection = new Connection("test", "test-renew-ttl");
    const sessionData = { userId: 999 };

    // Create session
    await api.session.create(connection, sessionData);

    // Get initial TTL
    const ttlBefore = await api.redis.redis.ttl(`session:${connection.id}`);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Load session (should renew TTL)
    await api.session.load(connection);

    // Get new TTL
    const ttlAfter = await api.redis.redis.ttl(`session:${connection.id}`);

    // TTL should be renewed (equal or greater than before, accounting for time passed)
    expect(ttlAfter).toBeGreaterThanOrEqual(ttlBefore - 1);
  });

  test("update merges new data with existing", async () => {
    const connection = new Connection("test", "test-update");
    const initialData: Record<string, unknown> = {
      userId: 111,
      username: "initial",
    };

    // Create session
    const session = await api.session.create(connection, initialData);

    // Update with new data
    const updatedData = await api.session.update(session, {
      role: "moderator",
    });

    expect(updatedData).toEqual({
      userId: 111,
      username: "initial",
      role: "moderator",
    });

    // Load and verify
    const loadedSession = await api.session.load(connection);
    expect(loadedSession?.data).toEqual(updatedData);
  });

  test("update overwrites existing fields", async () => {
    const connection = new Connection("test", "test-update-overwrite");
    const initialData = { userId: 222, count: 1 };

    // Create session
    const session = await api.session.create(connection, initialData);

    // Update existing field
    await api.session.update(session, { count: 10 });

    // Load and verify
    const loadedSession = await api.session.load(connection);
    expect(loadedSession?.data.count).toBe(10);
  });

  test("update renews TTL", async () => {
    const connection = new Connection("test", "test-update-ttl");
    const initialData = { userId: 333 };

    // Create session
    const session = await api.session.create(connection, initialData);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Get TTL before update
    const ttlBefore = await api.redis.redis.ttl(`session:${connection.id}`);

    // Update session
    await api.session.update(session, { updated: true });

    // Get TTL after update
    const ttlAfter = await api.redis.redis.ttl(`session:${connection.id}`);

    // TTL should be renewed
    expect(ttlAfter).toBeGreaterThanOrEqual(ttlBefore);
  });

  test("destroy removes session from Redis", async () => {
    const connection = new Connection("test", "test-destroy");
    const sessionData = { userId: 444 };

    // Create session
    await api.session.create(connection, sessionData);

    // Verify it exists
    let session = await api.session.load(connection);
    expect(session).not.toBeNull();

    // Destroy session
    const destroyed = await api.session.destroy(connection);

    expect(destroyed).toBe(true);

    // Verify it's gone
    session = await api.session.load(connection);
    expect(session).toBeNull();
  });

  test("destroy returns false when session doesn't exist", async () => {
    const connection = new Connection("test", "test-destroy-nonexistent");

    const destroyed = await api.session.destroy(connection);

    expect(destroyed).toBe(false);
  });

  test("session data can contain complex objects", async () => {
    const connection = new Connection("test", "test-complex-data");
    const complexData = {
      userId: 555,
      preferences: {
        theme: "dark",
        notifications: true,
      },
      recentActions: ["login", "view", "edit"],
      metadata: {
        loginTime: new Date().toISOString(),
        ipAddress: "127.0.0.1",
      },
    };

    await api.session.create(connection, complexData);

    const loadedSession = await api.session.load(connection);

    expect(loadedSession?.data).toEqual(complexData);
  });

  test("multiple sessions can coexist", async () => {
    const connection1 = new Connection("test", "test-multi-1");
    const connection2 = new Connection("test", "test-multi-2");

    await api.session.create(connection1, { userId: 1, name: "User 1" });
    await api.session.create(connection2, { userId: 2, name: "User 2" });

    const session1 = await api.session.load(connection1);
    const session2 = await api.session.load(connection2);

    expect(session1?.data.userId).toBe(1);
    expect(session2?.data.userId).toBe(2);
    expect(session1?.id).not.toBe(session2?.id);
  });

  test("session cookieName matches config", async () => {
    const connection = new Connection("test", "test-cookie-name");

    const session = await api.session.create(connection, { userId: 666 });

    expect(session.cookieName).toBe(config.session.cookieName);
  });
});
