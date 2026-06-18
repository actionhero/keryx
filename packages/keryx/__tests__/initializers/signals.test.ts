import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "../../api";
import { HOOK_TIMEOUT } from "./../setup";

beforeAll(async () => {
  await api.initialize();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("signals initializer", () => {
  test("signals namespace is initialized", () => {
    expect(api.signals).toBeDefined();
  });

  test("exposes a stop function", () => {
    expect(typeof api.signals.stop).toBe("function");
  });
});
