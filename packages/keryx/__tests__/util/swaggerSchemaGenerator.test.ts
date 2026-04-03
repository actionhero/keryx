import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "fs/promises";
import path from "path";
import { api } from "../../api";
import {
  computeActionsHash,
  generateSwaggerSchemas,
  loadCachedSchemas,
  writeSchemasCache,
} from "../../util/swaggerSchemaGenerator";
import { HOOK_TIMEOUT } from "../setup";

const testCacheDir = path.join(api.rootDir, ".cache-test");

beforeAll(async () => {
  await rm(testCacheDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(testCacheDir, { recursive: true, force: true });
});

describe("computeActionsHash", () => {
  test("returns a consistent hash for the same files", async () => {
    const hash1 = await computeActionsHash(api.rootDir);
    const hash2 = await computeActionsHash(api.rootDir);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  test("returns a hash even when actions dir does not exist", async () => {
    const hash = await computeActionsHash("/tmp/nonexistent-dir-12345");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("loadCachedSchemas", () => {
  test("returns null for missing cache", async () => {
    const result = await loadCachedSchemas("/tmp/nonexistent-dir-12345");
    expect(result).toBeNull();
  });

  test("returns null for corrupted cache", async () => {
    const corruptDir = path.join(testCacheDir, "corrupt");
    await Bun.write(
      path.join(corruptDir, ".cache", "swagger-schemas.json"),
      "not json",
    );
    const result = await loadCachedSchemas(corruptDir);
    expect(result).toBeNull();
  });

  test("returns cached data for valid cache", async () => {
    const validDir = path.join(testCacheDir, "valid");
    const data = {
      hash: "abc123",
      responseSchemas: { "test:action": { type: "object" } },
    };
    await Bun.write(
      path.join(validDir, ".cache", "swagger-schemas.json"),
      JSON.stringify(data),
    );
    const result = await loadCachedSchemas(validDir);
    expect(result).toEqual(data);
  });
});

describe("writeSchemasCache", () => {
  test("creates cache directory and writes valid JSON", async () => {
    const writeDir = path.join(testCacheDir, "write-test");
    const data = {
      hash: "def456",
      responseSchemas: { status: { type: "object" as const } },
    };
    await writeSchemasCache(writeDir, data);

    const file = Bun.file(
      path.join(writeDir, ".cache", "swagger-schemas.json"),
    );
    expect(await file.exists()).toBe(true);
    const parsed = await file.json();
    expect(parsed.hash).toBe("def456");
    expect(parsed.responseSchemas.status).toEqual({ type: "object" });
  });
});

describe("generateSwaggerSchemas", () => {
  test(
    "generates schemas for known actions",
    async () => {
      const result = await generateSwaggerSchemas({
        rootDir: api.rootDir,
        packageDir: api.packageDir,
      });

      expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.keys(result.responseSchemas).length).toBeGreaterThan(0);

      // The built-in status action should have a schema
      const statusSchema = result.responseSchemas["status"];
      expect(statusSchema).toBeDefined();
      expect(statusSchema.type).toBe("object");
    },
    HOOK_TIMEOUT,
  );
});
