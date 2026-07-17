import { describe, expect, it } from "bun:test";
import { extractStructuredData } from "../extract";

describe("extractStructuredData", () => {
  it("prefers structuredContent when present", () => {
    const data = extractStructuredData<{ a: number }>({
      structuredContent: { a: 1 },
      content: [{ type: "text", text: "ignored" }],
    });
    expect(data).toEqual({ a: 1 });
  });

  it("falls back to JSON in the first text block", () => {
    const data = extractStructuredData<{ b: string }>({
      content: [{ type: "text", text: JSON.stringify({ b: "x" }) }],
    });
    expect(data).toEqual({ b: "x" });
  });

  it("returns null for non-JSON text", () => {
    expect(
      extractStructuredData({ content: [{ type: "text", text: "hello" }] }),
    ).toBeNull();
  });

  it("ignores a JSON array (not a renderable object)", () => {
    expect(
      extractStructuredData({ content: [{ type: "text", text: "[1,2,3]" }] }),
    ).toBeNull();
  });

  it("ignores an array structuredContent", () => {
    expect(extractStructuredData({ structuredContent: [1, 2, 3] })).toBeNull();
  });

  it("returns null when there is no data", () => {
    expect(extractStructuredData({})).toBeNull();
  });
});
