import { describe, expect, test } from "bun:test";
import { formatConnectionStringForLogging } from "../../util/connectionString";

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
