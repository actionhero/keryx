import { describe, expect, test } from "bun:test";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { KeryxContextManager } from "../initializer";

describe("KeryxContextManager", () => {
  test("active() returns ROOT_CONTEXT when nothing has been set", () => {
    const cm = new KeryxContextManager();
    expect(cm.active()).toBe(ROOT_CONTEXT);
  });

  test("enterWith() makes the given context active for the rest of the async task", async () => {
    const cm = new KeryxContextManager();
    const key = Symbol("k") as unknown as Parameters<
      typeof ROOT_CONTEXT.setValue
    >[0];
    const ctx = ROOT_CONTEXT.setValue(key, "value-a");

    await (async () => {
      cm.enterWith(ctx);
      expect(cm.active()).toBe(ctx);
      await Promise.resolve();
      // persists across an awaited tick within the same async frame
      expect(cm.active().getValue(key)).toBe("value-a");
    })();
  });

  test("with() scopes the context to the callback and restores on exit", () => {
    const cm = new KeryxContextManager();
    const key = Symbol("k") as unknown as Parameters<
      typeof ROOT_CONTEXT.setValue
    >[0];
    const ctxA = ROOT_CONTEXT.setValue(key, "a");
    const ctxB = ROOT_CONTEXT.setValue(key, "b");

    cm.with(ctxA, () => {
      expect(cm.active()).toBe(ctxA);
      cm.with(ctxB, () => {
        expect(cm.active()).toBe(ctxB);
      });
      expect(cm.active()).toBe(ctxA);
    });
    expect(cm.active()).toBe(ROOT_CONTEXT);
  });

  test("with() preserves context across awaits inside the callback", async () => {
    const cm = new KeryxContextManager();
    const key = Symbol("k") as unknown as Parameters<
      typeof ROOT_CONTEXT.setValue
    >[0];
    const ctx = ROOT_CONTEXT.setValue(key, "inside");

    await cm.with(ctx, async () => {
      await Promise.resolve();
      expect(cm.active().getValue(key)).toBe("inside");
    });
  });

  test("async tasks spawned after enterWith inherit the context", async () => {
    const cm = new KeryxContextManager();
    const key = Symbol("k") as unknown as Parameters<
      typeof ROOT_CONTEXT.setValue
    >[0];
    const ctx = ROOT_CONTEXT.setValue(key, "parent");

    await (async () => {
      cm.enterWith(ctx);
      const child = async () => cm.active().getValue(key);
      expect(await child()).toBe("parent");
    })();
  });
});
