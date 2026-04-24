import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, config } from "keryx";
import { tracingPlugin } from "..";
import { HOOK_TIMEOUT } from "./setup";

beforeAll(async () => {
  config.plugins = [tracingPlugin];
  await api.initialize();
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
  config.plugins = [];
}, HOOK_TIMEOUT);

describe("tracing plugin", () => {
  test("api.tracing namespace exists with no-op defaults (tracing disabled)", () => {
    expect(api.tracing).toBeDefined();
    expect(api.tracing.enabled).toBe(false);
    expect(api.tracing.tracer).toBeDefined();
  });

  test("no-op tracer does not throw", () => {
    const span = api.tracing.tracer.startSpan("test");
    expect(span).toBeDefined();
    expect(() => span.end()).not.toThrow();
  });

  test("extractContext returns a Context when tracing is disabled", () => {
    const ctx = api.tracing.extractContext(new Headers());
    expect(ctx).toBeDefined();
  });

  test("injectContext is a no-op when tracing is disabled", () => {
    expect(() => api.tracing.injectContext({})).not.toThrow();
  });
});
