import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { config } from "../../config";
import {
  buildComponentView,
  type ComponentDef,
  getComponentDef,
  getComponentDefs,
  getValidTypes,
  loadGenerateTemplate,
  loadScaffoldTemplate,
  resolveComponentPath,
  resolveTestPath,
  toClassName,
  toRoute,
} from "../../util/componentRegistry";

describe("getComponentDefs (built-ins)", () => {
  test("exposes all six built-in types", () => {
    const types = getComponentDefs().map((d) => d.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "action",
        "initializer",
        "middleware",
        "channel",
        "ops",
        "plugin",
      ]),
    );
  });

  test("each built-in template file exists on disk", () => {
    const builtIns = getComponentDefs().filter((d) =>
      [
        "action",
        "initializer",
        "middleware",
        "channel",
        "ops",
        "plugin",
      ].includes(d.type),
    );
    for (const def of builtIns) {
      expect(fs.existsSync(def.templatePath)).toBe(true);
    }
  });

  test("action def has includeRoute and no class suffix", () => {
    const def = getComponentDef("action")!;
    expect(def.directory).toBe("actions");
    expect(def.includeRoute).toBe(true);
    expect(def.classSuffix).toBeUndefined();
  });

  test("middleware/channel/plugin defs carry their class suffix", () => {
    expect(getComponentDef("middleware")!.classSuffix).toBe("Middleware");
    expect(getComponentDef("channel")!.classSuffix).toBe("Channel");
    expect(getComponentDef("plugin")!.classSuffix).toBe("Plugin");
  });

  test("plain types (initializer, ops) have no class suffix or route", () => {
    for (const type of ["initializer", "ops"]) {
      const def = getComponentDef(type)!;
      expect(def.classSuffix).toBeUndefined();
      expect(def.includeRoute).toBeUndefined();
    }
  });

  test("getComponentDef returns undefined for unknown types", () => {
    expect(getComponentDef("nope")).toBeUndefined();
  });

  test("getValidTypes is the list of def types", () => {
    expect(getValidTypes()).toEqual(getComponentDefs().map((d) => d.type));
  });
});

describe("getComponentDefs (with plugin generators)", () => {
  afterEach(() => {
    // Remove any test plugins we pushed
    config.plugins = config.plugins.filter(
      (p) => !p.name.startsWith("registry-test-"),
    );
  });

  test("includes plugin-contributed generators", () => {
    config.plugins.push({
      name: "registry-test-a",
      version: "0.0.1",
      generators: [
        {
          type: "resolver",
          directory: "resolvers",
          templatePath: "/fake/resolver.mustache",
        },
      ],
    });

    const types = getValidTypes();
    expect(types).toContain("resolver");

    const def = getComponentDef("resolver")!;
    expect(def.directory).toBe("resolvers");
    expect(def.templatePath).toBe("/fake/resolver.mustache");
  });

  test("plugin testTemplatePath is carried through", () => {
    config.plugins.push({
      name: "registry-test-b",
      version: "0.0.1",
      generators: [
        {
          type: "widget",
          directory: "widgets",
          templatePath: "/fake/widget.mustache",
          testTemplatePath: "/fake/widget.test.mustache",
        },
      ],
    });

    const def = getComponentDef("widget")!;
    expect(def.testTemplatePath).toBe("/fake/widget.test.mustache");
  });

  test("built-ins win when a plugin reuses a built-in type", () => {
    config.plugins.push({
      name: "registry-test-c",
      version: "0.0.1",
      generators: [
        {
          type: "action",
          directory: "overridden",
          templatePath: "/fake/override.mustache",
        },
      ],
    });

    const def = getComponentDef("action")!;
    expect(def.directory).toBe("actions");
    expect(def.templatePath).not.toBe("/fake/override.mustache");
  });

  test("first plugin wins when two plugins declare the same type", () => {
    config.plugins.push({
      name: "registry-test-d",
      version: "0.0.1",
      generators: [
        {
          type: "thingy",
          directory: "first",
          templatePath: "/fake/first.mustache",
        },
      ],
    });
    config.plugins.push({
      name: "registry-test-e",
      version: "0.0.1",
      generators: [
        {
          type: "thingy",
          directory: "second",
          templatePath: "/fake/second.mustache",
        },
      ],
    });

    const def = getComponentDef("thingy")!;
    expect(def.directory).toBe("first");
  });
});

describe("resolveComponentPath", () => {
  const def: ComponentDef = {
    type: "action",
    directory: "actions",
    templatePath: "/unused",
  };

  test("flat name → directory/name.ts", () => {
    expect(resolveComponentPath(def, "hello")).toBe(
      path.join("actions", "hello.ts"),
    );
  });

  test("colon-separated name nests subdirectories", () => {
    expect(resolveComponentPath(def, "user:delete")).toBe(
      path.join("actions", "user", "delete.ts"),
    );
  });

  test("deeply nested colon names", () => {
    expect(resolveComponentPath(def, "a:b:c:d")).toBe(
      path.join("actions", "a", "b", "c", "d.ts"),
    );
  });

  test("honors the def's directory", () => {
    const initDef: ComponentDef = {
      type: "initializer",
      directory: "initializers",
      templatePath: "/unused",
    };
    expect(resolveComponentPath(initDef, "cache")).toBe(
      path.join("initializers", "cache.ts"),
    );
  });
});

describe("resolveTestPath", () => {
  test("flat component path → __tests__/<dir>/<name>.test.ts", () => {
    expect(resolveTestPath(path.join("actions", "hello.ts"))).toBe(
      path.join("__tests__", "actions", "hello.test.ts"),
    );
  });

  test("nested component path preserves subdirectories", () => {
    expect(resolveTestPath(path.join("actions", "user", "delete.ts"))).toBe(
      path.join("__tests__", "actions", "user", "delete.test.ts"),
    );
  });
});

describe("toClassName", () => {
  test("capitalizes a single segment", () => {
    expect(toClassName("hello")).toBe("Hello");
  });

  test("joins colon segments in PascalCase", () => {
    expect(toClassName("user:delete")).toBe("UserDelete");
    expect(toClassName("a:b:c")).toBe("ABC");
  });

  test("preserves already-uppercase chars after the first", () => {
    expect(toClassName("userOps")).toBe("UserOps");
  });
});

describe("toRoute", () => {
  test("prefixes a slash", () => {
    expect(toRoute("hello")).toBe("/hello");
  });

  test("converts colons to slashes", () => {
    expect(toRoute("user:delete")).toBe("/user/delete");
    expect(toRoute("a:b:c")).toBe("/a/b/c");
  });
});

describe("buildComponentView", () => {
  test("action view includes route", () => {
    const def = getComponentDef("action")!;
    expect(buildComponentView(def, "hello")).toEqual({
      name: "hello",
      className: "Hello",
      route: "/hello",
    });
  });

  test("middleware view appends 'Middleware' to className, no route", () => {
    const def = getComponentDef("middleware")!;
    const view = buildComponentView(def, "auth");
    expect(view).toEqual({ name: "auth", className: "AuthMiddleware" });
  });

  test("channel view appends 'Channel'", () => {
    const def = getComponentDef("channel")!;
    expect(buildComponentView(def, "notifications").className).toBe(
      "NotificationsChannel",
    );
  });

  test("plugin view appends 'Plugin'", () => {
    const def = getComponentDef("plugin")!;
    expect(buildComponentView(def, "analytics").className).toBe(
      "AnalyticsPlugin",
    );
  });

  test("initializer view has no suffix, no route", () => {
    const def = getComponentDef("initializer")!;
    expect(buildComponentView(def, "cache")).toEqual({
      name: "cache",
      className: "Cache",
    });
  });

  test("colon-separated action names get a nested route and PascalCase class", () => {
    const def = getComponentDef("action")!;
    expect(buildComponentView(def, "user:delete")).toEqual({
      name: "user:delete",
      className: "UserDelete",
      route: "/user/delete",
    });
  });
});

describe("template loaders", () => {
  test("loadGenerateTemplate reads a real template", async () => {
    const content = await loadGenerateTemplate("action.ts.mustache");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("{{className}}");
  });

  test("loadGenerateTemplate rejects on missing file", async () => {
    await expect(
      loadGenerateTemplate("does-not-exist.mustache"),
    ).rejects.toThrow();
  });

  test("loadScaffoldTemplate reads a real template", async () => {
    const content = await loadScaffoldTemplate("keryx.ts.mustache");
    expect(content.length).toBeGreaterThan(0);
  });
});
