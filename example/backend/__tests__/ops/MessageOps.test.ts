import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { serializeMessage } from "../../ops/MessageOps";
import type { Message } from "../../schema/messages";
import { HOOK_TIMEOUT } from "./../setup";

beforeAll(async () => {
  await api.start();
  await api.db.clearDatabase();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("serializeMessage", () => {
  test("serializes message with all required fields", () => {
    const createdAt = new Date("2024-01-01T00:00:00Z");
    const updatedAt = new Date("2024-01-02T00:00:00Z");

    const mockMessage: Message = {
      id: 1,
      body: "Hello, world!",
      user_id: 42,
      createdAt,
      updatedAt,
    };

    const serialized = serializeMessage(mockMessage);

    expect(serialized.id).toBe(1);
    expect(serialized.body).toBe("Hello, world!");
    expect(serialized.user_id).toBe(42);
    expect(serialized.createdAt).toBe(createdAt.getTime());
    expect(serialized.updatedAt).toBe(updatedAt.getTime());
  });

  test("includes user_name when provided", () => {
    const mockMessage: Message = {
      id: 1,
      body: "Test message",
      user_id: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const serialized = serializeMessage(mockMessage, "John Doe");

    expect(serialized.user_name).toBe("John Doe");
  });

  test("handles undefined user_name", () => {
    const mockMessage: Message = {
      id: 1,
      body: "Test message",
      user_id: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const serialized = serializeMessage(mockMessage);

    expect(serialized.user_name).toBeUndefined();
  });

  test("handles explicitly undefined user_name", () => {
    const mockMessage: Message = {
      id: 1,
      body: "Test message",
      user_id: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const serialized = serializeMessage(mockMessage, undefined);

    expect(serialized.user_name).toBeUndefined();
  });

  test("converts timestamps to Unix timestamps", () => {
    const createdAt = new Date("2024-06-15T09:30:00Z");
    const updatedAt = new Date("2024-06-16T14:45:00Z");

    const mockMessage: Message = {
      id: 5,
      body: "Timestamp test",
      user_id: 20,
      createdAt,
      updatedAt,
    };

    const serialized = serializeMessage(mockMessage, "Test User");

    expect(typeof serialized.createdAt).toBe("number");
    expect(typeof serialized.updatedAt).toBe("number");
    expect(serialized.createdAt).toBe(createdAt.getTime());
    expect(serialized.updatedAt).toBe(updatedAt.getTime());
  });

  test("handles empty message body", () => {
    const mockMessage: Message = {
      id: 1,
      body: "",
      user_id: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const serialized = serializeMessage(mockMessage);

    expect(serialized.body).toBe("");
    expect(serialized.id).toBe(1);
  });

  test("handles long message body", () => {
    const longBody = "a".repeat(1000);
    const mockMessage: Message = {
      id: 1,
      body: longBody,
      user_id: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const serialized = serializeMessage(mockMessage, "Long Message User");

    expect(serialized.body).toBe(longBody);
    expect(serialized.body.length).toBe(1000);
    expect(serialized.user_name).toBe("Long Message User");
  });
});
