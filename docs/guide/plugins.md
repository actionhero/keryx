---
description: Plugins let third-party packages contribute actions, initializers, channels, servers, and config to a Keryx application.
---

# Plugins

::: tip Looking for first-party plugins?
See the [Plugins catalog](/plugins/) for ready-to-use plugins maintained by the Keryx team.
:::

Plugins package reusable functionality — initializers, actions, channels, servers, and config defaults — into npm modules that any Keryx app can install and register. If you've built an initializer or a set of actions that would be useful across projects, a plugin is how you distribute it.

## Using a Plugin

Install the plugin package, then add it to your config:

```ts
// config/plugins.ts
import { resqueAdminPlugin } from "@keryxjs/resque-admin";

export default {
  plugins: [resqueAdminPlugin],
};
```

That's it. The framework loads plugins during initialization — their initializers, actions, channels, and servers are discovered automatically.

## The KeryxPlugin Interface

A plugin is an object that satisfies the `KeryxPlugin` interface:

```ts
import type { KeryxPlugin } from "keryx";

export const myPlugin: KeryxPlugin = {
  name: "my-plugin",
  version: "1.0.0",

  // Class constructors (optional) — framework instantiates them
  initializers: [MyInitializer],
  actions: [MyAction, AnotherAction],
  channels: [MyChannel],
  servers: [MyServer],

  // Config defaults (optional) — merged before user config
  configDefaults: {
    myPlugin: {
      enabled: true,
      maxRetries: 3,
    },
  },

  // Custom generator types (optional)
  generators: [
    {
      type: "resolver",
      directory: "resolvers",
      templatePath: path.join(import.meta.dir, "templates/resolver.ts.mustache"),
    },
  ],
};
```

All fields except `name` and `version` are optional. Provide only what your plugin needs.

## What Plugins Can Provide

### Initializers

Plugin initializers work exactly like framework or user initializers — they extend the `Initializer` class, declare their dependencies via `dependsOn`, and can attach namespaces to the `api` singleton via module augmentation:

```ts
import { Initializer } from "keryx";

declare module "keryx" {
  export interface API {
    cache: Awaited<ReturnType<CacheInitializer["initialize"]>>;
  }
}

export class CacheInitializer extends Initializer {
  constructor() {
    super("cache");
    this.dependsOn = ["redis"]; // names of other initializers this one needs
  }

  async initialize() {
    const store = new Map<string, unknown>();
    return { get: (k: string) => store.get(k), set: (k: string, v: unknown) => store.set(k, v) };
  }
}
```

Users of the plugin need to import it (or the plugin package) so the module augmentation is visible to TypeScript:

```ts
import "@keryxjs/cache"; // side-effect import for type augmentation
```

### Actions

Plugin actions extend `Action` and are registered alongside the app's own actions. They show up in HTTP routing, the CLI, MCP, and Swagger automatically:

```ts
import { Action, HTTP_METHOD, type ActionParams } from "keryx";

export class HealthCheck extends Action {
  constructor() {
    super({
      name: "plugin:health",
      description: "Extended health check from plugin",
      web: { route: "/health", method: HTTP_METHOD.GET },
    });
  }

  async run(_params: ActionParams<this>) {
    return { healthy: true };
  }
}
```

### Channels

Plugin channels extend `Channel` and are registered alongside user channels:

```ts
import { Channel } from "keryx";

export class PluginNotifications extends Channel {
  constructor() {
    super({ name: /^plugin:notify:.*$/, description: "Plugin notification channel" });
  }
}
```

### Servers

Plugin servers extend `Server` and participate in the standard initialize → start → stop lifecycle.

### Config Defaults

Plugin config defaults are applied using `deepMergeDefaults` — they only fill in values that aren't already set. User config always takes precedence. Use module augmentation to make plugin config type-safe:

```ts
declare module "keryx" {
  interface KeryxConfig {
    myPlugin: { enabled: boolean; maxRetries: number };
  }
}
```

### Middleware

Middleware isn't registered through the plugin manifest — actions import and reference it directly. Just export your middleware from the plugin package:

```ts
// In your plugin package
export const MyPluginMiddleware: ActionMiddleware = {
  runBefore: async (params, connection) => { /* ... */ },
};
```

Users apply it to their actions:

```ts
import { MyPluginMiddleware } from "keryx-plugin-foo";

export class MyAction extends Action {
  constructor() {
    super({
      name: "my-action",
      middleware: [MyPluginMiddleware],
    });
  }
}
```

### Custom Generators

Plugins can register custom types for the `keryx generate` CLI command. Provide a Mustache template and an output directory:

```ts
{
  generators: [{
    type: "resolver",           // `keryx generate resolver myThing`
    directory: "resolvers",     // output: resolvers/myThing.ts
    templatePath: path.join(import.meta.dir, "templates/resolver.ts.mustache"),
    testTemplatePath: path.join(import.meta.dir, "templates/resolver.test.ts.mustache"),
  }]
}
```

The template receives `{{ name }}` and `{{ className }}` as variables.

## Loading Order

Understanding the loading order helps you declare `dependsOn` correctly:

1. **User config loaded** — from the app's `config/` directory (including `config.plugins`)
2. **Plugin config defaults applied** — via `deepMergeDefaults` (never overwrites user-set values)
3. **Initializer discovery** — framework → plugins → user (registration order within plugins)
4. **Initializer execution** — all initializers are topologically sorted by `dependsOn`, regardless of source
5. **Action discovery** — plugin actions → user actions
6. **Channel discovery** — plugin channels → user channels
7. **Server discovery** — framework servers → plugin servers → user servers

`dependsOn` names can refer to any initializer in the graph — framework, plugin, or user. Unknown names and cycles cause a startup error. Independent initializers keep their discovery order, so when two plugins are mutually independent the order they appear in `config.plugins` wins.

## Naming Convention

| Scope | Convention | Example |
|-------|-----------|---------|
| First-party | `@keryxjs/<name>` | `@keryxjs/resque-admin` |
| Third-party | `keryx-plugin-<name>` | `keryx-plugin-graphql` |

These are conventions, not enforced by the framework. The `name` field in the plugin manifest is what matters for uniqueness.

## Building a Plugin Package

A minimal plugin package:

```
keryx-plugin-hello/
  package.json
  index.ts
  actions/
    hello.ts
```

**`package.json`:**

```json
{
  "name": "keryx-plugin-hello",
  "version": "1.0.0",
  "type": "module",
  "module": "index.ts",
  "peerDependencies": {
    "keryx": ">=0.20.0"
  }
}
```

**`index.ts`:**

```ts
import type { KeryxPlugin } from "keryx";
import { HelloAction } from "./actions/hello";

export const helloPlugin: KeryxPlugin = {
  name: "hello",
  version: "1.0.0",
  actions: [HelloAction],
};
```

**`actions/hello.ts`:**

```ts
import { Action, HTTP_METHOD, type ActionParams } from "keryx";

export class HelloAction extends Action {
  constructor() {
    super({
      name: "hello",
      description: "Says hello",
      web: { route: "/hello", method: HTTP_METHOD.GET },
    });
  }

  async run(_params: ActionParams<this>) {
    return { message: "Hello from plugin!" };
  }
}
```

Use `keryx` as a peer dependency so the app controls the framework version.
