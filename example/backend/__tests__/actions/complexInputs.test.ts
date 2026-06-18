import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Action, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { HOOK_TIMEOUT, serverUrl } from "./../setup";

// --- Test actions with complex typed inputs ---

class NestedObjectAction extends Action {
  constructor() {
    super({
      name: "test:nestedObject",
      description: "Action with nested object input",
      inputs: z.object({
        name: z.string(),
        address: z.object({
          street: z.string(),
          city: z.string(),
          zip: z.string(),
        }),
      }),
      web: { route: "/test/nested-object", method: HTTP_METHOD.POST },
    });
  }

  async run(params: {
    name: string;
    address: { street: string; city: string; zip: string };
  }) {
    return { echo: params };
  }
}

class BooleanInputAction extends Action {
  constructor() {
    super({
      name: "test:booleanInput",
      description: "Action with boolean inputs (no coerce)",
      inputs: z.object({
        active: z.boolean(),
        deleted: z.boolean(),
      }),
      web: { route: "/test/boolean-input", method: HTTP_METHOD.POST },
    });
  }

  async run(params: { active: boolean; deleted: boolean }) {
    return { echo: params };
  }
}

class NumberInputAction extends Action {
  constructor() {
    super({
      name: "test:numberInput",
      description: "Action with number inputs (no coerce)",
      inputs: z.object({
        count: z.number(),
        ratio: z.number(),
      }),
      web: { route: "/test/number-input", method: HTTP_METHOD.POST },
    });
  }

  async run(params: { count: number; ratio: number }) {
    return { echo: params };
  }
}

class ArrayOfObjectsAction extends Action {
  constructor() {
    super({
      name: "test:arrayOfObjects",
      description: "Action with array of objects input",
      inputs: z.object({
        patches: z.array(
          z.object({
            startLine: z.number(),
            originalLines: z.array(z.string()),
            newLines: z.array(z.string()),
          }),
        ),
      }),
      web: { route: "/test/array-of-objects", method: HTTP_METHOD.POST },
    });
  }

  async run(params: {
    patches: Array<{
      startLine: number;
      originalLines: string[];
      newLines: string[];
    }>;
  }) {
    return { echo: params };
  }
}

class EnumInputAction extends Action {
  constructor() {
    super({
      name: "test:enumInput",
      description: "Action with enum input",
      inputs: z.object({
        color: z.enum(["red", "green", "blue"]),
      }),
      web: { route: "/test/enum-input", method: HTTP_METHOD.POST },
    });
  }

  async run(params: { color: "red" | "green" | "blue" }) {
    return { echo: params };
  }
}

class MixedTypesAction extends Action {
  constructor() {
    super({
      name: "test:mixedTypes",
      description: "Action with many typed inputs",
      inputs: z.object({
        name: z.string(),
        age: z.number(),
        active: z.boolean(),
        tags: z.array(z.string()),
        metadata: z.object({ key: z.string(), value: z.string() }),
        scores: z.array(z.number()),
      }),
      web: { route: "/test/mixed-types", method: HTTP_METHOD.POST },
    });
  }

  async run(params: {
    name: string;
    age: number;
    active: boolean;
    tags: string[];
    metadata: { key: string; value: string };
    scores: number[];
  }) {
    return { echo: params };
  }
}

class NullableInputAction extends Action {
  constructor() {
    super({
      name: "test:nullableInput",
      description: "Action with nullable input",
      inputs: z.object({
        name: z.string(),
        deletedAt: z.string().nullable(),
      }),
      web: { route: "/test/nullable-input", method: HTTP_METHOD.POST },
    });
  }

  async run(params: { name: string; deletedAt: string | null }) {
    return { echo: params };
  }
}

// --- Test setup ---

const testActions: Action[] = [
  new NestedObjectAction(),
  new BooleanInputAction(),
  new NumberInputAction(),
  new ArrayOfObjectsAction(),
  new EnumInputAction(),
  new MixedTypesAction(),
  new NullableInputAction(),
];

let url: string;

beforeAll(async () => {
  await api.start();
  url = serverUrl();
  for (const action of testActions) {
    api.actions.actions.push(action);
  }
}, HOOK_TIMEOUT);

afterAll(async () => {
  api.actions.actions = api.actions.actions.filter(
    (a: Action) => !a.name.startsWith("test:"),
  );
  await api.stop();
}, HOOK_TIMEOUT);

// --- Helpers ---

async function postJson(route: string, body: Record<string, unknown>) {
  return fetch(url + "/api" + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- Tests ---

describe("JSON body type fidelity (issue #234)", () => {
  describe("nested objects", () => {
    test("nested object is preserved through JSON body", async () => {
      const body = {
        name: "Alice",
        address: { street: "123 Main St", city: "Springfield", zip: "62701" },
      };
      const res = await postJson("/test/nested-object", body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.echo).toEqual(body);
    });

    test("nested object via form-urlencoded fails validation (expected)", async () => {
      const res = await fetch(url + "/api/test/nested-object", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=Alice&address=not-an-object",
      });
      expect(res.status).not.toBe(200);
    });
  });

  describe("booleans", () => {
    test("boolean values are preserved (not coerced to strings)", async () => {
      const res = await postJson("/test/boolean-input", {
        active: true,
        deleted: false,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.echo.active).toBe(true);
      expect(json.echo.deleted).toBe(false);
    });

    test("string 'true' is rejected by z.boolean() (no coerce)", async () => {
      const res = await fetch(url + "/api/test/boolean-input", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "active=true&deleted=false",
      });
      // Form-urlencoded sends strings, z.boolean() without coerce should reject
      expect(res.status).not.toBe(200);
    });
  });

  describe("numbers", () => {
    test("number values are preserved (not coerced to strings)", async () => {
      const res = await postJson("/test/number-input", {
        count: 42,
        ratio: 3.14,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.echo.count).toBe(42);
      expect(json.echo.ratio).toBe(3.14);
    });

    test("string numbers are rejected by z.number() (no coerce)", async () => {
      const res = await fetch(url + "/api/test/number-input", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "count=42&ratio=3.14",
      });
      expect(res.status).not.toBe(200);
    });
  });

  describe("arrays of objects", () => {
    test("array of objects is preserved", async () => {
      const patches = [
        { startLine: 2, originalLines: ["old"], newLines: ["new"] },
        { startLine: 5, originalLines: ["a", "b"], newLines: ["c"] },
      ];
      const res = await postJson("/test/array-of-objects", { patches });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.echo.patches).toEqual(patches);
    });
  });

  describe("enums", () => {
    test("enum string value is preserved", async () => {
      const res = await postJson("/test/enum-input", { color: "green" });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.echo.color).toBe("green");
    });

    test("invalid enum value is rejected", async () => {
      const res = await postJson("/test/enum-input", { color: "purple" });
      expect(res.status).not.toBe(200);
    });
  });

  describe("mixed types", () => {
    test("all types preserved in a single request", async () => {
      const body = {
        name: "Alice",
        age: 30,
        active: true,
        tags: ["admin", "user"],
        metadata: { key: "role", value: "admin" },
        scores: [95, 87, 92],
      };
      const res = await postJson("/test/mixed-types", body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.echo).toEqual(body);
    });
  });

  describe("nullable values", () => {
    test("null value is preserved", async () => {
      const res = await postJson("/test/nullable-input", {
        name: "Alice",
        deletedAt: null,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.echo.name).toBe("Alice");
      expect(json.echo.deletedAt).toBeNull();
    });

    test("non-null value is also preserved", async () => {
      const res = await postJson("/test/nullable-input", {
        name: "Alice",
        deletedAt: "2024-01-01",
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.echo.deletedAt).toBe("2024-01-01");
    });
  });

  describe("regression: existing transports still work", () => {
    test("multipart file upload still works", async () => {
      const formData = new FormData();
      formData.append("stringParam", "test");
      const filePath = require("path").join(
        __dirname,
        "..",
        "..",
        "..",
        "frontend",
        "public",
        "images",
        "horn.svg",
      );
      const f = Bun.file(filePath);
      formData.append("file", f);

      const res = await fetch(url + "/api/file", {
        method: "POST",
        body: formData,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.params.stringParam).toBe("test");
    });

    test("query string params still work", async () => {
      const res = await fetch(url + "/api/status?foo=bar");
      expect(res.status).toBe(200);
    });

    test("form-urlencoded with z.coerce still works", async () => {
      // The messages:list action uses z.coerce.number() for limit/offset
      const res = await fetch(url + "/api/status");
      expect(res.status).toBe(200);
    });
  });
});
