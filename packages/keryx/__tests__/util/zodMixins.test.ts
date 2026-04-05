import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  isSecret,
  paginationInputs,
  secret,
  zBooleanFromString,
} from "../../util/zodMixins";

describe("secret", () => {
  test("marks a schema as secret via meta", () => {
    const schema = secret(z.string());
    expect(isSecret(schema)).toBe(true);
  });

  test("unmarked schema is not secret", () => {
    const schema = z.string();
    expect(isSecret(schema)).toBe(false);
  });

  test("works with different schema types", () => {
    expect(isSecret(secret(z.number()))).toBe(true);
    expect(isSecret(secret(z.boolean()))).toBe(true);
    expect(isSecret(secret(z.object({ a: z.string() })))).toBe(true);
  });
});

describe("isSecret", () => {
  test("returns true for secret schema", () => {
    const schema = secret(z.string());
    expect(isSecret(schema)).toBe(true);
  });

  test("returns false for non-secret schema", () => {
    const schema = z.string();
    expect(isSecret(schema)).toBe(false);
  });
});

describe("zBooleanFromString", () => {
  test("passes through boolean true", () => {
    const schema = zBooleanFromString();
    expect(schema.parse(true)).toBe(true);
  });

  test("passes through boolean false", () => {
    const schema = zBooleanFromString();
    expect(schema.parse(false)).toBe(false);
  });

  test("parses string 'true' to boolean true", () => {
    const schema = zBooleanFromString();
    expect(schema.parse("true")).toBe(true);
  });

  test("parses string 'false' to boolean false", () => {
    const schema = zBooleanFromString();
    expect(schema.parse("false")).toBe(false);
  });

  test("parses case-insensitive 'TRUE' to boolean true", () => {
    const schema = zBooleanFromString();
    expect(schema.parse("TRUE")).toBe(true);
  });

  test("parses case-insensitive 'False' to boolean false", () => {
    const schema = zBooleanFromString();
    expect(schema.parse("False")).toBe(false);
  });

  test("returns false for unrecognized string", () => {
    const schema = zBooleanFromString();
    expect(schema.parse("yes")).toBe(false);
  });
});

describe("paginationInputs", () => {
  test("provides default page=1 and limit=25", () => {
    const schema = paginationInputs();
    const result = schema.parse({});
    expect(result).toEqual({ page: 1, limit: 25 });
  });

  test("coerces string inputs", () => {
    const schema = paginationInputs();
    const result = schema.parse({ page: "3", limit: "50" });
    expect(result).toEqual({ page: 3, limit: 50 });
  });

  test("rejects page < 1", () => {
    const schema = paginationInputs();
    expect(() => schema.parse({ page: 0 })).toThrow();
  });

  test("rejects limit > maxLimit", () => {
    const schema = paginationInputs();
    expect(() => schema.parse({ limit: 101 })).toThrow();
  });

  test("rejects limit < 1", () => {
    const schema = paginationInputs();
    expect(() => schema.parse({ limit: 0 })).toThrow();
  });

  test("accepts custom defaults", () => {
    const schema = paginationInputs({ defaultLimit: 10, maxLimit: 50 });
    const result = schema.parse({});
    expect(result).toEqual({ page: 1, limit: 10 });
  });

  test("enforces custom maxLimit", () => {
    const schema = paginationInputs({ maxLimit: 50 });
    expect(() => schema.parse({ limit: 51 })).toThrow();
  });
});
