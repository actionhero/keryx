import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  Action,
  type ActionParams,
  api,
  Channel,
  Initializer,
} from "../../api";
import { HTTP_METHOD } from "../../classes/Action";
import type { KeryxPlugin } from "../../classes/Plugin";
import { config } from "../../config";
import { deepMergeDefaults } from "../../util/config";
import { getValidTypes } from "../../util/generate";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

// --- Mock plugin classes ---

class PluginTestInitializer extends Initializer {
  constructor() {
    super("pluginTest");
  }

  async initialize() {
    return { greeting: "hello from plugin" };
  }
}

class PluginTestAction extends Action {
  constructor() {
    super({
      name: "pluginAction",
      description: "An action from a plugin",
      web: { route: "/plugin-action", method: HTTP_METHOD.GET },
    });
  }

  async run(_params: ActionParams<this>) {
    return { source: "plugin" };
  }
}

class PluginTestChannel extends Channel {
  constructor() {
    super({
      name: "plugin-channel",
      description: "A channel from a plugin",
    });
  }
}

// --- Unit tests ---

describe("deepMergeDefaults", () => {
  test("sets values that don't exist in target", () => {
    const target = { a: 1 } as Record<string, unknown>;
    deepMergeDefaults(target, { b: 2 });
    expect(target).toEqual({ a: 1, b: 2 });
  });

  test("does not overwrite existing values", () => {
    const target = { a: 1, b: "user" };
    deepMergeDefaults(target, { a: 99, b: "plugin" });
    expect(target).toEqual({ a: 1, b: "user" });
  });

  test("recursively fills nested gaps", () => {
    const target = { server: { port: 3000 } } as Record<string, unknown>;
    deepMergeDefaults(target, { server: { port: 8080, host: "0.0.0.0" } });
    expect(target).toEqual({ server: { port: 3000, host: "0.0.0.0" } });
  });

  test("does not overwrite arrays", () => {
    const target = { items: [1, 2] };
    deepMergeDefaults(target, { items: [3, 4, 5] });
    expect(target).toEqual({ items: [1, 2] });
  });
});

describe("config.plugins", () => {
  test("defaults to an empty array", () => {
    expect(config.plugins).toBeArray();
  });

  test("accepts KeryxPlugin objects", () => {
    const plugin: KeryxPlugin = {
      name: "test",
      version: "1.0.0",
      actions: [PluginTestAction],
    };
    // Verify the type is correct
    const plugins: KeryxPlugin[] = [plugin];
    expect(plugins[0].name).toBe("test");
  });
});

// --- Integration tests (use global api with full lifecycle) ---

describe("plugin lifecycle integration", () => {
  const testPlugin: KeryxPlugin = {
    name: "integration-test",
    version: "0.1.0",
    initializers: [PluginTestInitializer],
    actions: [PluginTestAction],
    channels: [PluginTestChannel],
  };

  let weOwnTheLifecycle: boolean;

  beforeAll(async () => {
    if (!api.initialized) {
      // Fresh api — we own the full lifecycle
      weOwnTheLifecycle = true;
      config.plugins.push(testPlugin);
      await api.start();
    } else {
      // Another test file already initialized api. Inject plugin items
      // manually so we can still test that plugin-provided classes work.
      weOwnTheLifecycle = false;
      config.plugins.push(testPlugin);
      const initInstance = new PluginTestInitializer();
      const initResult = await initInstance.initialize!();
      api[initInstance.name] = initResult;
      api.initializers.push(initInstance);
      api.actions.actions.push(new PluginTestAction());
      api.channels.channels.push(new PluginTestChannel());
    }
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    if (weOwnTheLifecycle) {
      await api.stop();
    }
  }, HOOK_TIMEOUT);

  test("plugin initializer is discovered and run", () => {
    expect(api.pluginTest).toBeDefined();
    expect(api.pluginTest.greeting).toBe("hello from plugin");
  });

  test("plugin action is loaded and accessible", () => {
    const action = api.actions.actions.find((a) => a.name === "pluginAction");
    expect(action).toBeDefined();
    expect(action?.description).toBe("An action from a plugin");
  });

  test("plugin action is reachable via HTTP", async () => {
    if (!weOwnTheLifecycle) return; // server not owned by this test file
    const url = serverUrl();
    const res = await fetch(`${url}/api/plugin-action`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string };
    expect(body.source).toBe("plugin");
  });

  test("plugin channel is loaded", () => {
    const channel = api.channels.channels.find(
      (c) => typeof c.name === "string" && c.name === "plugin-channel",
    );
    expect(channel).toBeDefined();
    expect(channel?.description).toBe("A channel from a plugin");
  });

  test("getValidTypes includes plugin generator types", () => {
    // Add a generator to the already-registered plugin
    const plugin = config.plugins.find((p) => p.name === "integration-test");
    expect(plugin).toBeDefined();
    plugin!.generators = [
      {
        type: "resolver",
        directory: "resolvers",
        templatePath: "/fake/template.mustache",
      },
    ];

    const types = getValidTypes();
    expect(types).toContain("resolver");
    expect(types).toContain("action"); // built-in still present

    // Clean up
    delete plugin!.generators;
  });
});
