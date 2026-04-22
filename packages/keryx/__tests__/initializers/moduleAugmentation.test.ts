import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const INITIALIZERS_DIR = path.resolve(__dirname, "../../initializers");

describe("framework initializer module augmentations", () => {
  const files = fs
    .readdirSync(INITIALIZERS_DIR)
    .filter((f) => f.endsWith(".ts"));

  test("at least one initializer is present", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)("%s augments `keryx`, not a relative path", (file) => {
    const source = fs.readFileSync(path.join(INITIALIZERS_DIR, file), "utf-8");
    if (!source.includes("declare module")) return;

    // Consumers installing keryx via npm only see augmentations to the
    // package name. Relative-path augmentations do not propagate (#413).
    expect(source).toContain('declare module "keryx"');
    expect(source).not.toMatch(/declare module "\.\.?\/[^"]*"/);
  });
});
