import { describe, expect, test } from "bun:test";
import { API } from "../../classes/API";
import { Initializer } from "../../classes/Initializer";
import { LogLevel } from "../../classes/Logger";
import { ErrorType, TypedError } from "../../classes/TypedError";

class FakeInitializer extends Initializer {
  constructor(name: string, deps: string[] = []) {
    super(name);
    this.dependsOn = deps;
    this.declaresAPIProperty = false;
  }
}

function buildApi(initializers: Initializer[]): API {
  const api = new API();
  api.initializers = initializers;
  // Silence DAG output during tests by default; specific tests reassign logger.
  api.logger.quiet = true;
  return api;
}

function sortedNames(api: API): string[] {
  // @ts-expect-error — exercising the private sort for unit-level coverage
  api.topologicallySortInitializers();
  return api.initializers.map((i) => i.name);
}

describe("initializer DAG", () => {
  test("topological sort runs every dependency before its dependent", () => {
    const api = buildApi([
      new FakeInitializer("mcp", ["actions", "oauth"]),
      new FakeInitializer("oauth", ["redis", "actions"]),
      new FakeInitializer("actions"),
      new FakeInitializer("redis"),
    ]);

    const order = sortedNames(api);
    expect(order.indexOf("actions")).toBeLessThan(order.indexOf("oauth"));
    expect(order.indexOf("redis")).toBeLessThan(order.indexOf("oauth"));
    expect(order.indexOf("oauth")).toBeLessThan(order.indexOf("mcp"));
    expect(order.indexOf("actions")).toBeLessThan(order.indexOf("mcp"));
  });

  test("independent initializers keep their original insertion order", () => {
    const api = buildApi([
      new FakeInitializer("a"),
      new FakeInitializer("b"),
      new FakeInitializer("c"),
    ]);
    expect(sortedNames(api)).toEqual(["a", "b", "c"]);
  });

  test("throws on unknown dependency name", () => {
    const api = buildApi([new FakeInitializer("foo", ["missing"])]);

    expect(() => {
      // @ts-expect-error — exercising the private sort
      api.topologicallySortInitializers();
    }).toThrow(TypedError);

    try {
      // @ts-expect-error — exercising the private sort
      api.topologicallySortInitializers();
    } catch (e) {
      const err = e as TypedError;
      expect(err.type).toBe(ErrorType.INITIALIZER_VALIDATION);
      expect(err.message).toContain("foo");
      expect(err.message).toContain("missing");
    }
  });

  test("throws on circular dependencies", () => {
    const api = buildApi([
      new FakeInitializer("a", ["b"]),
      new FakeInitializer("b", ["a"]),
    ]);

    try {
      // @ts-expect-error — exercising the private sort
      api.topologicallySortInitializers();
      throw new Error("expected TypedError to be thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TypedError);
      const err = e as TypedError;
      expect(err.type).toBe(ErrorType.INITIALIZER_VALIDATION);
      expect(err.message).toContain("Circular dependency");
      expect(err.message).toContain("a");
      expect(err.message).toContain("b");
    }
  });

  test("renders the dependency graph to the logger at debug level", () => {
    const api = buildApi([
      new FakeInitializer("redis"),
      new FakeInitializer("session", ["redis"]),
    ]);

    const lines: string[] = [];
    api.logger.quiet = false;
    api.logger.level = LogLevel.trace;
    api.logger.colorize = false;
    api.logger.includeTimestamps = false;
    api.logger.outputStream = ((msg: string) => {
      lines.push(msg);
    }) as typeof console.log;

    // @ts-expect-error — exercising private methods
    api.topologicallySortInitializers();
    // @ts-expect-error — exercising private methods
    api.logInitializerDag();

    expect(lines.some((l) => l.includes("Initializer dependency graph"))).toBe(
      true,
    );
    expect(lines.some((l) => /\b1\s+redis\s/.test(l))).toBe(true);
    expect(lines.some((l) => /\b2\s+session\s+← redis/.test(l))).toBe(true);
  });

  test("reverses its order for stop (dependents stop before their dependencies)", () => {
    const api = buildApi([
      new FakeInitializer("redis"),
      new FakeInitializer("session", ["redis"]),
      new FakeInitializer("mcp", ["session"]),
    ]);

    const startOrder = sortedNames(api);
    const stopOrder = [...api.initializers].reverse().map((i) => i.name);

    expect(startOrder).toEqual(["redis", "session", "mcp"]);
    expect(stopOrder).toEqual(["mcp", "session", "redis"]);
  });
});
