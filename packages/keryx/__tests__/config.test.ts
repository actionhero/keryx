import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { KeryxConfig } from "../config";
import { config } from "../config";
import { deepMerge, loadFromEnvIfSet } from "../util/config";
import "./setup";

test("config can be loaded", () => {
  expect(config).toBeDefined();
});

test("config can have sub-parts", () => {
  expect(typeof config.server.web.port).toBe("number");
  expect(config.server.web.port).toBeGreaterThanOrEqual(0);
});

test("config maintains types", () => {
  expect(typeof config.server.web.port).toBe("number");
  expect(typeof config.server.web.host).toBe("string");
});

describe("deepMerge", () => {
  test("merges nested objects", () => {
    const target = { a: { b: 1, c: 2 }, d: 3 };
    deepMerge(target, { a: { b: 10 } });
    expect(target).toEqual({ a: { b: 10, c: 2 }, d: 3 });
  });

  test("overwrites primitives", () => {
    const target = { a: 1, b: "hello" };
    deepMerge(target, { a: 2, b: "world" });
    expect(target).toEqual({ a: 2, b: "world" });
  });

  test("overwrites arrays instead of merging them", () => {
    const target = { a: [1, 2, 3] };
    deepMerge(target, { a: [4, 5] });
    expect(target).toEqual({ a: [4, 5] });
  });

  test("adds new keys", () => {
    const target = { a: 1 } as Record<string, any>;
    deepMerge(target, { b: 2 });
    expect(target).toEqual({ a: 1, b: 2 });
  });

  test("handles deeply nested merges", () => {
    const target = { server: { web: { port: 8080, host: "localhost" } } };
    deepMerge(target, { server: { web: { port: 3000 } } });
    expect(target.server.web.port).toBe(3000);
    expect(target.server.web.host).toBe("localhost");
  });
});

describe("KeryxConfig interface", () => {
  test("KeryxConfig is an interface that can be augmented", () => {
    // Verify KeryxConfig is structurally compatible with the config object
    const typed: KeryxConfig = config;
    expect(typed.server.web.port).toBe(config.server.web.port);
  });

  test("augmented properties are accessible after deepMerge", () => {
    deepMerge(config, { custom: { enabled: true, name: "test" } });
    // Access via cast since the augmentation is only for this test
    const augmented = config as KeryxConfig & {
      custom: { enabled: boolean; name: string };
    };
    expect(augmented.custom.enabled).toBe(true);
    expect(augmented.custom.name).toBe("test");
    // Clean up
    delete (config as Record<string, unknown>).custom;
  });
});

describe("updating config", () => {
  let originalPort: number;
  beforeAll(() => {
    originalPort = config.server.web.port;
  });

  afterAll(() => {
    config.server.web.port = originalPort;
  });

  test("config can be overridden by environment variables", async () => {
    expect(await loadFromEnvIfSet("servers.web.port", 8081)).toEqual(8081);

    Bun.env["WEB_SERVER_PORT_TEST"] = "8081";
    expect(await loadFromEnvIfSet("servers.web.port", 8081)).toEqual(8081);
  });

  test("parsing works for various types", async () => {
    const scenarios = [
      1,
      0,
      -1,
      1.1,
      -1.1,
      "a",
      "1",
      true,
      false,
      "true",
      "false",
    ];

    for (const v of scenarios) {
      Bun.env["foo"] = v.toString();
      const output = await loadFromEnvIfSet("foo", v);
      expect(output).toEqual(v);
    }
  });
});
