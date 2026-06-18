import { afterAll, beforeAll, expect, test } from "bun:test";
import { api } from "../../api";
import { HOOK_TIMEOUT } from "./../setup";

beforeAll(async () => {
  await api.initialize();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

test("the server process is set", async () => {
  expect(api.process.name).toContain("test-server");
  expect(api.process.pid).toBeGreaterThan(0);
});
