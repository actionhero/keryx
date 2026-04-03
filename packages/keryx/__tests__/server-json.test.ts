import { expect, test } from "bun:test";
import { resolve } from "path";

const packageJsonPath = resolve(import.meta.dir, "../package.json");
const serverJsonPath = resolve(import.meta.dir, "../server.json");

test("server.json version matches package.json version", async () => {
  const packageJson = await Bun.file(packageJsonPath).json();
  const serverJson = await Bun.file(serverJsonPath).json();

  expect(serverJson.version).toBe(packageJson.version);
  expect(serverJson.packages[0].version).toBe(packageJson.version);
});

test("server.json name matches package.json mcpName", async () => {
  const packageJson = await Bun.file(packageJsonPath).json();
  const serverJson = await Bun.file(serverJsonPath).json();

  expect(serverJson.name).toBe(packageJson.mcpName);
});
