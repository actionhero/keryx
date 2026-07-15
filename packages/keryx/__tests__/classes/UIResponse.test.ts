import { describe, expect, test } from "bun:test";
import { UIResponse } from "../../classes/UIResponse";

describe("UIResponse", () => {
  test("defaults text to JSON.stringify(structuredContent)", () => {
    const data = { name: "server", pid: 42 };
    const res = new UIResponse(data);
    expect(res.structuredContent).toEqual(data);
    expect(res.text).toBe(JSON.stringify(data));
  });

  test("uses provided model-facing text", () => {
    const res = new UIResponse({ ok: true }, { text: "All good" });
    expect(res.text).toBe("All good");
    expect(res.structuredContent).toEqual({ ok: true });
  });

  test("static from() is equivalent to the constructor", () => {
    const res = UIResponse.from({ a: 1 }, { text: "one" });
    expect(res).toBeInstanceOf(UIResponse);
    expect(res.structuredContent).toEqual({ a: 1 });
    expect(res.text).toBe("one");
  });

  test("toJSON() serializes to the structured payload, not the wrapper", () => {
    const data = { count: 3, items: ["a", "b"] };
    const res = new UIResponse(data);
    expect(res.toJSON()).toEqual(data);
    // So HTTP/WS/CLI transports serialize the data, not { structuredContent, text }.
    expect(JSON.parse(JSON.stringify(res))).toEqual(data);
  });
});
