import { describe, expect, test } from "bun:test";
import { rm } from "fs/promises";
import path from "path";
import { api, logger } from "../../api";
import { LogLevel } from "../../classes/Logger";
import { SwaggerInitializer } from "../../initializers/swagger";
import {
  computeActionsHash,
  loadCachedSchemas,
  SCHEMA_CACHE_DIR,
  SCHEMA_CACHE_RELATIVE_PATH,
  writeSchemasCache,
} from "../../util/swaggerSchemaGenerator";
import { HOOK_TIMEOUT, useTestServer } from "./../setup";

useTestServer();

/**
 * Run the swagger initializer with the cache in a given state, capturing every
 * log line it emits so we can assert on both content and ordering. Restores the
 * logger and the original cache file afterwards.
 */
async function initializeCapturingLogs(
  prepareCache: () => Promise<void>,
): Promise<string[]> {
  const originalCache = await loadCachedSchemas(api.rootDir);
  const originalStream = logger.outputStream;
  const originalLevel = logger.level;
  const lines: string[] = [];

  logger.outputStream = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  logger.level = LogLevel.info;

  try {
    await prepareCache();
    await new SwaggerInitializer().initialize();
  } finally {
    logger.outputStream = originalStream;
    logger.level = originalLevel;
    if (originalCache) await writeSchemasCache(api.rootDir, originalCache);
  }

  return lines;
}

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

// Generating schemas via ts-morph can peak over 1 GB of RSS, which is enough to
// get a container OOM-killed mid-boot. The warning has to be emitted *before*
// the work starts, or the process that most needs it never lives to log it.
describe("swagger cache-miss warning", () => {
  test(
    "warns and names `keryx build` before running ts-morph",
    async () => {
      const lines = await initializeCapturingLogs(() =>
        rm(path.join(api.rootDir, SCHEMA_CACHE_DIR), {
          recursive: true,
          force: true,
        }),
      );

      const warnIndex = lines.findIndex((line) =>
        line.includes("no swagger schema cache found"),
      );
      const generatedIndex = lines.findIndex((line) =>
        line.includes("response schemas for swagger"),
      );

      expect(warnIndex).toBeGreaterThanOrEqual(0);
      expect(lines[warnIndex]).toContain(`[${LogLevel.warn}]`);
      expect(lines[warnIndex]).toContain(SCHEMA_CACHE_RELATIVE_PATH);
      expect(lines[warnIndex]).toContain("keryx build");
      expect(lines[warnIndex]).toContain("OOM");

      // The warning must precede the generation it is warning about.
      expect(generatedIndex).toBeGreaterThan(warnIndex);
    },
    HOOK_TIMEOUT,
  );

  test(
    "distinguishes a stale cache from a missing one",
    async () => {
      const lines = await initializeCapturingLogs(async () => {
        await writeSchemasCache(api.rootDir, {
          hash: "stale-hash",
          responseSchemas: {},
        });
      });

      const warning = lines.find((line) => line.includes("keryx build"));
      expect(warning).toBeDefined();
      expect(warning).toContain("is stale");
    },
    HOOK_TIMEOUT,
  );

  test("says nothing when the cache is valid", async () => {
    const lines = await initializeCapturingLogs(async () => {
      const hash = await computeActionsHash(api.rootDir);
      await writeSchemasCache(api.rootDir, {
        hash,
        responseSchemas: api.swagger.responseSchemas,
      });
    });

    expect(lines.find((line) => line.includes("keryx build"))).toBeUndefined();
  });
});
