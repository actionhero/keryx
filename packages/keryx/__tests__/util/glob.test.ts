import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import path from "path";
import { TypedError } from "../../classes/TypedError";
import { globModuleExports } from "../../util/glob";

const isTable = (value: unknown): value is PgTable => is(value, PgTable);
const fixtureSchemaDir = path.join(import.meta.dir, "..", "fixtures", "schema");

describe("globModuleExports", () => {
  test("collects matching exports from every file in the directory", async () => {
    const registry = await globModuleExports(fixtureSchemaDir, isTable);

    expect(Object.keys(registry).sort()).toEqual(["gadgets", "widgets"]);
    expect(isTable(registry.widgets)).toBe(true);
    expect(isTable(registry.gadgets)).toBe(true);
  });

  test("keys off the export name, not the SQL table name", async () => {
    const registry = await globModuleExports(fixtureSchemaDir, isTable);

    expect(getTableName(registry.gadgets)).toBe("gadgets_table");
    expect(registry.gadgets_table).toBeUndefined();
  });

  test("skips exports the predicate rejects", async () => {
    const registry = await globModuleExports(fixtureSchemaDir, isTable);

    // widgets.ts also exports a const array and a function.
    expect(registry.WIDGET_KINDS).toBeUndefined();
    expect(registry.widgetLabel).toBeUndefined();
  });

  test("returns an empty registry for a directory that does not exist", async () => {
    const missing = path.join(import.meta.dir, "no-such-directory");

    expect(await globModuleExports(missing, isTable)).toEqual({});
  });

  test("honors a predicate that selects non-class values", async () => {
    const isStringArray = (value: unknown): value is readonly string[] =>
      Array.isArray(value) && value.every((v) => typeof v === "string");

    const registry = await globModuleExports(fixtureSchemaDir, isStringArray);

    expect(registry.WIDGET_KINDS).toEqual(["round", "square"]);
    expect(registry.widgets).toBeUndefined();
  });

  test("wraps import failures in a TypedError naming the offending file", async () => {
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "keryx-glob-"));
    fs.writeFileSync(
      path.join(brokenDir, "syntaxError.ts"),
      "export const broken = (",
    );

    try {
      await expect(globModuleExports(brokenDir, isTable)).rejects.toThrow(
        TypedError,
      );
      await expect(globModuleExports(brokenDir, isTable)).rejects.toThrow(
        /syntaxError\.ts/,
      );
    } finally {
      fs.rmSync(brokenDir, { recursive: true, force: true });
    }
  });
});
