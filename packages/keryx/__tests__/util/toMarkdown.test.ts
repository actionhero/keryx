import { describe, expect, test } from "bun:test";
import { toMarkdown } from "../../util/toMarkdown";

describe("toMarkdown", () => {
  describe("primitives", () => {
    test("string", () => {
      expect(toMarkdown("hello")).toBe("hello");
    });

    test("number", () => {
      expect(toMarkdown(42)).toBe("42");
    });

    test("boolean", () => {
      expect(toMarkdown(true)).toBe("true");
    });

    test("null returns empty", () => {
      expect(toMarkdown(null)).toBe("");
    });

    test("undefined returns empty", () => {
      expect(toMarkdown(undefined)).toBe("");
    });
  });

  describe("flat objects", () => {
    test("renders key-value bullet list", () => {
      const result = toMarkdown({ name: "keryx", pid: 1234, uptime: 5000 });
      expect(result).toBe(
        ["- **name**: keryx", "- **pid**: 1234", "- **uptime**: 5000"].join(
          "\n",
        ),
      );
    });

    test("empty object returns empty", () => {
      expect(toMarkdown({})).toBe("");
    });

    test("null values render as empty string", () => {
      const result = toMarkdown({ key: null });
      expect(result).toBe("- **key**:");
    });
  });

  describe("arrays of primitives", () => {
    test("renders bulleted list", () => {
      const result = toMarkdown(["alpha", "beta", "gamma"]);
      expect(result).toBe(["- alpha", "- beta", "- gamma"].join("\n"));
    });

    test("empty array returns empty", () => {
      expect(toMarkdown([])).toBe("");
    });
  });

  describe("arrays of uniform objects", () => {
    test("renders markdown table", () => {
      const result = toMarkdown([
        { id: 1, body: "hello", userId: 5 },
        { id: 2, body: "world", userId: 3 },
      ]);
      expect(result).toBe(
        [
          "| id | body | userId |",
          "| --- | --- | --- |",
          "| 1 | hello | 5 |",
          "| 2 | world | 3 |",
        ].join("\n"),
      );
    });

    test("escapes pipe characters in table cells", () => {
      const result = toMarkdown([{ value: "a|b" }]);
      expect(result).toContain("a\\|b");
    });
  });

  describe("nested objects", () => {
    test("uses headings for nested keys", () => {
      const result = toMarkdown({
        user: { id: 1, name: "Evan" },
        session: { token: "abc" },
      });
      expect(result).toContain("## user");
      expect(result).toContain("- **id**: 1");
      expect(result).toContain("- **name**: Evan");
      expect(result).toContain("## session");
      expect(result).toContain("- **token**: abc");
    });

    test("mixed flat and nested keys", () => {
      const result = toMarkdown({
        count: 5,
        user: { id: 1, name: "Evan" },
      });
      expect(result).toContain("- **count**: 5");
      expect(result).toContain("## user");
      expect(result).toContain("- **id**: 1");
    });
  });

  describe("depth limit", () => {
    test("falls back to JSON code block at max depth", () => {
      const deep = { a: { b: { c: "value" } } };
      const result = toMarkdown(deep, { maxDepth: 2 });
      expect(result).toContain("```json");
      expect(result).toContain('"c": "value"');
      expect(result).toContain("```");
    });

    test("default depth of 5 handles moderately nested data", () => {
      const obj = { l1: { l2: { l3: { l4: { name: "deep" } } } } };
      const result = toMarkdown(obj);
      // Should still render as markdown (4 levels of nesting < 5)
      expect(result).toContain("- **name**: deep");
      expect(result).not.toContain("```json");
    });

    test("default depth of 5 falls back at level 5", () => {
      const obj = {
        l1: { l2: { l3: { l4: { l5: { name: "too deep" } } } } },
      };
      const result = toMarkdown(obj);
      expect(result).toContain("```json");
    });
  });

  describe("heading levels", () => {
    test("starts at h2 by default", () => {
      const result = toMarkdown({ section: { key: "val" } });
      expect(result).toContain("## section");
    });

    test("custom starting heading level", () => {
      const result = toMarkdown(
        { section: { key: "val" } },
        { headingLevel: 3 },
      );
      expect(result).toContain("### section");
    });

    test("caps at h6 then uses bold", () => {
      // 5 levels of nesting starting from h4 → h4, h5, h6, **bold**
      const obj = { a: { b: { c: { d: { key: "val" } } } } };
      const result = toMarkdown(obj, { headingLevel: 4 });
      expect(result).toContain("#### a");
      expect(result).toContain("##### b");
      expect(result).toContain("###### c");
      expect(result).toContain("**d**");
    });
  });

  describe("arrays of non-uniform objects", () => {
    test("renders as bulleted list when keys differ", () => {
      const result = toMarkdown([
        { id: 1, name: "Evan" },
        { id: 2, email: "e@t.com" },
      ]);
      expect(result).toContain("- ");
      // Should not be a table since keys differ
      expect(result).not.toContain("| id |");
    });
  });

  describe("wrapped collection pattern", () => {
    test("object wrapping an array of objects", () => {
      const result = toMarkdown({
        messages: [
          { id: 1, body: "hello" },
          { id: 2, body: "world" },
        ],
      });
      expect(result).toContain("## messages");
      expect(result).toContain("| id | body |");
      expect(result).toContain("| 1 | hello |");
    });
  });
});
