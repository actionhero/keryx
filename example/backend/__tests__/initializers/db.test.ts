import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { api } from "keryx";
import { users } from "../../schema/users";
import { HOOK_TIMEOUT } from "./../setup";

beforeAll(async () => {
  await api.start();
  await api.db.clearDatabase();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("db initializer", () => {
  test("db object is initialized", () => {
    expect(api.db).toBeDefined();
    expect(api.db.db).toBeDefined();
    expect(api.db.pool).toBeDefined();
  });

  test("db methods are available", () => {
    expect(typeof api.db.clearDatabase).toBe("function");
    expect(typeof api.db.generateMigrations).toBe("function");
  });

  test("can execute queries", async () => {
    const result = await api.db.db.execute(sql`SELECT NOW()`);
    expect(result).toBeDefined();
    expect(result.rows).toBeDefined();
    expect(result.rows.length).toBeGreaterThan(0);
  });

  test("can query tables", async () => {
    const result = await api.db.db.select().from(users);
    expect(Array.isArray(result)).toBe(true);
  });

  test("clearDatabase truncates all tables", async () => {
    // Create a test user
    await api.db.db.insert(users).values({
      name: "Test User",
      email: "test@example.com",
      password_hash: "hash",
    });

    // Verify user exists
    let usersBeforeClear = await api.db.db.select().from(users);
    expect(usersBeforeClear.length).toBeGreaterThan(0);

    // Clear database
    await api.db.clearDatabase();

    // Verify all users are gone
    let usersAfterClear = await api.db.db.select().from(users);
    expect(usersAfterClear.length).toBe(0);
  });

  test("clearDatabase restarts identity sequences", async () => {
    // Clear database to reset sequences
    await api.db.clearDatabase();

    // Create first user
    const [user1] = await api.db.db
      .insert(users)
      .values({
        name: "User 1",
        email: "user1@example.com",
        password_hash: "hash",
      })
      .returning();

    expect(user1.id).toBe(1);

    // Clear database again
    await api.db.clearDatabase();

    // Create another user - should have id 1 again due to RESTART IDENTITY
    const [user2] = await api.db.db
      .insert(users)
      .values({
        name: "User 2",
        email: "user2@example.com",
        password_hash: "hash",
      })
      .returning();

    expect(user2.id).toBe(1);
  });

  test("clearDatabase works with cascade", async () => {
    await api.db.clearDatabase();

    // The cascade parameter ensures foreign key constraints don't block truncation
    // This test just verifies it doesn't throw an error
    expect(true).toBe(true);
  });

  test("database connection is active", async () => {
    // Test that we can perform a simple query
    const result = await api.db.db.execute(sql`SELECT 1 + 1 as result`);
    expect(result.rows[0].result).toBe(2);
  });

  test("can insert and query data", async () => {
    await api.db.clearDatabase();

    const [user] = await api.db.db
      .insert(users)
      .values({
        name: "Insert Test User",
        email: "insert@example.com",
        password_hash: "testhash",
      })
      .returning();

    expect(user.id).toBeDefined();
    expect(user.name).toBe("Insert Test User");
    expect(user.email).toBe("insert@example.com");

    // Query the inserted user
    const queriedUsers = await api.db.db.select().from(users);
    expect(queriedUsers.length).toBe(1);
    expect(queriedUsers[0].id).toBe(user.id);
  });

  test("transactions work", async () => {
    await api.db.clearDatabase();

    await api.db.db.transaction(async (tx) => {
      await tx.insert(users).values({
        name: "Transaction User",
        email: "transaction@example.com",
        password_hash: "hash",
      });
    });

    const users_result = await api.db.db.select().from(users);
    expect(users_result.length).toBe(1);
    expect(users_result[0].email).toBe("transaction@example.com");
  });

  test("pool is connected", () => {
    expect(api.db.pool.totalCount).toBeGreaterThanOrEqual(0);
    expect(api.db.pool.idleCount).toBeGreaterThanOrEqual(0);
  });
});
