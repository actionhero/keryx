import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import {
  checkPassword,
  hashPassword,
  serializePublicUser,
  serializeUser,
} from "../../ops/UserOps";
import type { User } from "../../schema/users";
import { HOOK_TIMEOUT } from "./../setup";

beforeAll(async () => {
  await api.start();
  await api.db.clearDatabase();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("hashPassword", () => {
  test("creates a valid bcrypt hash", async () => {
    const password = "testPassword123";
    const hash = await hashPassword(password);

    expect(hash).toBeDefined();
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).not.toBe(password);
  });

  test("creates different hashes for the same password", async () => {
    const password = "testPassword123";
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);

    expect(hash1).not.toBe(hash2);
  });
});

describe("checkPassword", () => {
  test("verifies correct password", async () => {
    const password = "correctPassword123";
    const hash = await hashPassword(password);

    const mockUser: User = {
      id: 1,
      name: "Test User",
      email: "test@example.com",
      password_hash: hash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const isValid = await checkPassword(mockUser, password);
    expect(isValid).toBe(true);
  });

  test("rejects incorrect password", async () => {
    const correctPassword = "correctPassword123";
    const incorrectPassword = "wrongPassword456";
    const hash = await hashPassword(correctPassword);

    const mockUser: User = {
      id: 1,
      name: "Test User",
      email: "test@example.com",
      password_hash: hash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const isValid = await checkPassword(mockUser, incorrectPassword);
    expect(isValid).toBe(false);
  });

  test("rejects empty password", async () => {
    const password = "correctPassword123";
    const hash = await hashPassword(password);

    const mockUser: User = {
      id: 1,
      name: "Test User",
      email: "test@example.com",
      password_hash: hash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const isValid = await checkPassword(mockUser, "");
    expect(isValid).toBe(false);
  });
});

describe("serializeUser", () => {
  test("includes all expected fields including email", () => {
    const createdAt = new Date("2024-01-01T00:00:00Z");
    const updatedAt = new Date("2024-01-02T00:00:00Z");

    const mockUser: User = {
      id: 1,
      name: "Test User",
      email: "test@example.com",
      password_hash: "hashedpassword",
      createdAt,
      updatedAt,
    };

    const serialized = serializeUser(mockUser);

    expect(serialized.id).toBe(1);
    expect(serialized.name).toBe("Test User");
    expect(serialized.email).toBe("test@example.com");
    expect(serialized.createdAt).toBe(createdAt.getTime());
    expect(serialized.updatedAt).toBe(updatedAt.getTime());
  });

  test("converts timestamps to Unix timestamps", () => {
    const createdAt = new Date("2024-01-01T12:30:45Z");
    const updatedAt = new Date("2024-01-02T15:45:30Z");

    const mockUser: User = {
      id: 1,
      name: "Test User",
      email: "test@example.com",
      password_hash: "hashedpassword",
      createdAt,
      updatedAt,
    };

    const serialized = serializeUser(mockUser);

    expect(typeof serialized.createdAt).toBe("number");
    expect(typeof serialized.updatedAt).toBe("number");
    expect(serialized.createdAt).toBe(createdAt.getTime());
    expect(serialized.updatedAt).toBe(updatedAt.getTime());
  });

  test("does not include password_hash", () => {
    const mockUser: User = {
      id: 1,
      name: "Test User",
      email: "test@example.com",
      password_hash: "hashedpassword",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const serialized = serializeUser(mockUser);

    expect(serialized).not.toHaveProperty("password_hash");
  });
});

describe("serializePublicUser", () => {
  test("excludes email field", () => {
    const mockUser: User = {
      id: 1,
      name: "Test User",
      email: "test@example.com",
      password_hash: "hashedpassword",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const serialized = serializePublicUser(mockUser);

    expect(serialized.id).toBe(1);
    expect(serialized.name).toBe("Test User");
    expect(serialized).not.toHaveProperty("email");
  });

  test("includes id, name, and timestamps", () => {
    const createdAt = new Date("2024-01-01T00:00:00Z");
    const updatedAt = new Date("2024-01-02T00:00:00Z");

    const mockUser: User = {
      id: 42,
      name: "Public User",
      email: "public@example.com",
      password_hash: "hashedpassword",
      createdAt,
      updatedAt,
    };

    const serialized = serializePublicUser(mockUser);

    expect(serialized.id).toBe(42);
    expect(serialized.name).toBe("Public User");
    expect(serialized.createdAt).toBe(createdAt.getTime());
    expect(serialized.updatedAt).toBe(updatedAt.getTime());
  });

  test("converts timestamps to Unix timestamps", () => {
    const createdAt = new Date("2024-06-15T09:30:00Z");
    const updatedAt = new Date("2024-06-16T14:45:00Z");

    const mockUser: User = {
      id: 1,
      name: "Test User",
      email: "test@example.com",
      password_hash: "hashedpassword",
      createdAt,
      updatedAt,
    };

    const serialized = serializePublicUser(mockUser);

    expect(typeof serialized.createdAt).toBe("number");
    expect(typeof serialized.updatedAt).toBe("number");
    expect(serialized.createdAt).toBe(createdAt.getTime());
    expect(serialized.updatedAt).toBe(updatedAt.getTime());
  });

  test("does not include password_hash", () => {
    const mockUser: User = {
      id: 1,
      name: "Test User",
      email: "test@example.com",
      password_hash: "hashedpassword",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const serialized = serializePublicUser(mockUser);

    expect(serialized).not.toHaveProperty("password_hash");
  });
});
