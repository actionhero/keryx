import { describe, expect, test } from "bun:test";
import { rm } from "fs/promises";
import path from "path";
import { api } from "../../api";
import {
  computeActionsHash,
  loadCachedSchemas,
  writeSchemasCache,
} from "../../util/swaggerSchemaGenerator";
import { useTestServer } from "./../setup";

useTestServer();

describe("swagger initializer", () => {
  test("swagger namespace is initialized", () => {
    expect(api.swagger).toBeDefined();
    expect(api.swagger.responseSchemas).toBeDefined();
    expect(typeof api.swagger.responseSchemas).toBe("object");
  });

  test("responseSchemas contains entries for loaded actions", () => {
    const schemas = api.swagger.responseSchemas;
    const keys = Object.keys(schemas);
    expect(keys.length).toBeGreaterThan(0);
  });

  test("built-in status action has a response schema", () => {
    const statusSchema = api.swagger.responseSchemas["status"];
    expect(statusSchema).toBeDefined();
    expect(statusSchema.type).toBe("object");
  });

  test("response schemas have valid JSON Schema structure", () => {
    for (const schema of Object.values(api.swagger.responseSchemas)) {
      const s = schema as Record<string, unknown>;
      // Every schema should be an object with a type or a composite (oneOf, etc.)
      expect(s.type || s.oneOf || s.$ref).toBeDefined();
    }
  });

  test("object schemas have properties", () => {
    const statusSchema = api.swagger.responseSchemas["status"];
    if (statusSchema.type === "object" && statusSchema.properties) {
      expect(Object.keys(statusSchema.properties).length).toBeGreaterThan(0);
    }
  });
});

describe("swagger cache behavior", () => {
  test("cache file is written after schema generation", async () => {
    const cached = await loadCachedSchemas(api.rootDir);
    expect(cached).not.toBeNull();
    expect(Object.keys(cached!.responseSchemas).length).toBeGreaterThan(0);
  });

  test("cache hash matches current action files", async () => {
    const currentHash = await computeActionsHash(api.rootDir);
    const cached = await loadCachedSchemas(api.rootDir);
    expect(cached!.hash).toBe(currentHash);
  });

  test("pre-written cache is used when hash matches", async () => {
    // The cache was written by the initializer during beforeAll.
    // Verify it contains the same schemas as the live api.swagger.
    const cached = await loadCachedSchemas(api.rootDir);
    expect(cached).not.toBeNull();
    for (const actionName of Object.keys(api.swagger.responseSchemas)) {
      expect(cached!.responseSchemas[actionName]).toBeDefined();
    }
  });

  test("writeSchemasCache + loadCachedSchemas round-trips correctly", async () => {
    const tmpDir = path.join(api.rootDir, ".cache-roundtrip-test");
    try {
      const data = {
        hash: "test-hash-123",
        responseSchemas: {
          "test:action": { type: "object" as const, properties: {} },
        },
      };
      await writeSchemasCache(tmpDir, data);
      const loaded = await loadCachedSchemas(tmpDir);
      expect(loaded).toEqual(data);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
