import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { api } from "keryx";
import { MessagesCleanup, MessagesHello } from "../../actions/message";
import { messages } from "../../schema/messages";
import { users } from "../../schema/users";
import { HOOK_TIMEOUT } from "./../setup";

beforeAll(async () => {
  await api.start();
  await api.db.clearDatabase();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("messages:cleanup", () => {
  // Clear database before each test to ensure isolation
  beforeEach(async () => {
    await api.db.clearDatabase();
  });

  test("deletes messages older than default age (24 hours)", async () => {
    // Create a test user
    const [user] = await api.db.db
      .insert(users)
      .values({
        name: "Test User",
        email: "test@example.com",
        password_hash: "hash",
      })
      .returning();

    // Create an old message (older than 24 hours) using postgres interval
    await api.db.db.execute(
      sql`INSERT INTO messages (body, user_id, created_at, updated_at)
          VALUES ('Old message', ${user.id}, NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')`,
    );

    // Create a recent message
    await api.db.db.insert(messages).values({
      body: "Recent message",
      user_id: user.id,
    });

    const action = new MessagesCleanup();
    const result = await action.run({ age: 1000 * 60 * 60 * 24 }); // 24 hours

    expect(result.messagesDeleted).toBe(1);

    // Verify old message was deleted
    const remainingMessages = await api.db.db.select().from(messages);
    expect(remainingMessages.length).toBe(1);
    expect(remainingMessages[0].body).toBe("Recent message");
  });

  test("does not delete recent messages", async () => {
    // Create a test user
    const [user] = await api.db.db
      .insert(users)
      .values({
        name: "Test User",
        email: "test@example.com",
        password_hash: "hash",
      })
      .returning();

    // Create only recent messages
    await api.db.db.insert(messages).values({
      body: "Recent message 1",
      user_id: user.id,
    });

    await api.db.db.insert(messages).values({
      body: "Recent message 2",
      user_id: user.id,
    });

    const action = new MessagesCleanup();
    const result = await action.run({ age: 1000 * 60 * 60 * 24 }); // 24 hours

    expect(result.messagesDeleted).toBe(0);

    // Verify all messages still exist
    const remainingMessages = await api.db.db.select().from(messages);
    expect(remainingMessages.length).toBe(2);
  });

  test("returns correct count of deleted messages", async () => {
    // Create a test user
    const [user] = await api.db.db
      .insert(users)
      .values({
        name: "Test User",
        email: "test@example.com",
        password_hash: "hash",
      })
      .returning();

    // Create multiple old messages using postgres intervals
    for (let i = 0; i < 5; i++) {
      await api.db.db.execute(
        sql`INSERT INTO messages (body, user_id, created_at, updated_at)
            VALUES (${`Old message ${i}`}, ${user.id}, NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')`,
      );
    }

    const action = new MessagesCleanup();
    const result = await action.run({ age: 1000 * 60 * 60 * 24 }); // 24 hours

    expect(result.messagesDeleted).toBe(5);
  });

  test("works with empty database", async () => {
    // Create a test user
    await api.db.db
      .insert(users)
      .values({
        name: "Test User",
        email: "test@example.com",
        password_hash: "hash",
      })
      .returning();

    const action = new MessagesCleanup();
    const result = await action.run({ age: 1000 * 60 * 60 * 24 }); // 24 hours

    expect(result.messagesDeleted).toBe(0);
  });
});

describe("messages:hello", () => {
  // Clear database before each test to ensure isolation
  beforeEach(async () => {
    await api.db.clearDatabase();
  });

  // Helper to ensure default user exists
  async function ensureDefaultUser() {
    // Check if default user exists
    const [existingUser] = await api.db.db
      .select()
      .from(users)
      .where(eq(users.email, "admin@keryxjs.com"))
      .limit(1);

    if (existingUser) {
      api.application.defaultUser = existingUser;
      return existingUser;
    }

    // Create default user if it doesn't exist
    const [user] = await api.db.db
      .insert(users)
      .values({
        name: "Admin",
        email: "admin@keryxjs.com",
        password_hash: "hash",
      })
      .returning();

    api.application.defaultUser = user;
    return user;
  }

  test("creates a new message", async () => {
    await ensureDefaultUser();

    const messageCountBefore = await api.db.db.select().from(messages);

    const action = new MessagesHello();
    await action.run();

    const messageCountAfter = await api.db.db.select().from(messages);
    expect(messageCountAfter.length).toBe(messageCountBefore.length + 1);
  });

  test("message uses default user", async () => {
    await ensureDefaultUser();

    const action = new MessagesHello();
    await action.run();

    const allMessages = await api.db.db.select().from(messages);
    const helloMessage = allMessages[0];

    expect(helloMessage.user_id).toBe(api.application.defaultUser.id);
  });

  test("message body includes timestamp", async () => {
    await ensureDefaultUser();

    const action = new MessagesHello();
    const result = await action.run();

    expect(result.message).toContain("Hello!");
    expect(result.message).toContain("The current time is");

    // Verify it has an ISO timestamp
    const isoDateRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    expect(result.message).toMatch(isoDateRegex);
  });

  test("returns message body", async () => {
    await ensureDefaultUser();

    const action = new MessagesHello();
    const result = await action.run();

    expect(result).toHaveProperty("message");
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("message is persisted in database", async () => {
    await ensureDefaultUser();

    const action = new MessagesHello();
    const result = await action.run();

    const [savedMessage] = await api.db.db
      .select()
      .from(messages)
      .where(eq(messages.user_id, api.application.defaultUser.id))
      .limit(1);

    expect(savedMessage).toBeDefined();
    expect(savedMessage.body).toContain(result.message);
    expect(savedMessage.user_id).toBe(api.application.defaultUser.id);
  });

  test("creates unique timestamps for each call", async () => {
    await ensureDefaultUser();

    const action = new MessagesHello();
    const result1 = await action.run();

    // Wait a tiny bit to ensure different timestamp
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result2 = await action.run();

    expect(result1.message).not.toBe(result2.message);

    const allMessages = await api.db.db.select().from(messages);
    expect(allMessages.length).toBe(2);
  });
});
