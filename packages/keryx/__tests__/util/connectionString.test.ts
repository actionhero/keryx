import { describe, expect, test } from "bun:test";
import {
  formatConnectionStringForLogging,
  isDatabaseDisabled,
  isMemoryRedis,
} from "../../util/connectionString";

describe("formatConnectionStringForLogging", () => {
  test("strips password from connection string", () => {
    const result = formatConnectionStringForLogging(
      "postgres://user:s3cret@host:5432/mydb",
    );
    expect(result).toBe("postgres://user@host:5432/mydb");
    expect(result).not.toContain("s3cret");
  });

  test("preserves URL when no password present", () => {
    const result = formatConnectionStringForLogging(
      "postgres://user@host:5432/mydb",
    );
    expect(result).toBe("postgres://user@host:5432/mydb");
  });

  test("handles connection string with no username", () => {
    const result = formatConnectionStringForLogging(
      "postgres://host:5432/mydb",
    );
    expect(result).toBe("postgres://host:5432/mydb");
  });

  test("handles special characters in path", () => {
    const result = formatConnectionStringForLogging(
      "postgres://user:pass@host:5432/my-db_test",
    );
    expect(result).toBe("postgres://user@host:5432/my-db_test");
    expect(result).not.toContain("pass");
  });
});

describe("formatConnectionStringForLogging with unparseable input", () => {
  test("does not throw on an empty string", () => {
    expect(formatConnectionStringForLogging("")).toBe(
      "(invalid connection string)",
    );
  });
});

describe("isMemoryRedis", () => {
  test("matches memory: URLs", () => {
    expect(isMemoryRedis("memory://")).toBe(true);
    expect(isMemoryRedis("MEMORY://")).toBe(true);
    expect(isMemoryRedis("memory:")).toBe(true);
  });

  test("does not match real redis URLs", () => {
    expect(isMemoryRedis("redis://localhost:6379/0")).toBe(false);
    expect(isMemoryRedis("rediss://memory.example.com:6379")).toBe(false);
  });
});

describe("isDatabaseDisabled", () => {
  test("empty and 'none' disable the database", () => {
    expect(isDatabaseDisabled("")).toBe(true);
    expect(isDatabaseDisabled("  ")).toBe(true);
    expect(isDatabaseDisabled("none")).toBe(true);
    expect(isDatabaseDisabled("NONE")).toBe(true);
  });

  test("a postgres URL keeps the database enabled", () => {
    expect(isDatabaseDisabled("postgres://localhost:5432/app")).toBe(false);
  });
});
