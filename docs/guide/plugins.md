---
description: Plugins let third-party packages contribute actions, initializers, channels, servers, and config to a Keryx application.
---

# Plugins

::: tip Looking for first-party plugins?
See the [Plugins catalog](/plugins/) for ready-to-use plugins maintained by the Keryx team.
:::

Plugins package reusable functionality — initializers, actions, channels, servers, and config defaults — into npm modules that any Keryx app can install and register. If you've built an initializer or a set of actions that would be useful across projects, a plugin is how you distribute it.

## First-Party Plugins

| Package | Description |
|---------|-------------|
| [`@keryxjs/tracing`](/plugins/tracing) | OpenTelemetry distributed tracing (OTLP) for HTTP, actions, tasks, Redis, and Drizzle |
| [`@keryxjs/resque-admin`](/plugins/resque-admin) | Web dashboard and API for monitoring Redis, queues, workers, failed jobs, and locks |

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

### Lifecycle Hooks

Plugins can observe or wrap framework-wide lifecycle events across five namespaces: HTTP requests, WebSocket connections, MCP sessions, actions, and background tasks. All hooks are registered via the `api.hooks` namespace from code (not the plugin manifest), typically inside a plugin initializer's `initialize()`.

Use lifecycle hooks when action middleware (`runBefore` / `runAfter`) isn't enough — for example, to wrap an entire HTTP request in a tracing span, inject trace headers into every enqueued job, or restore distributed trace context before a worker runs an action.

```ts
import { api, Initializer } from "keryx";

class MyTracer extends Initializer {
  constructor() {
    super("myTracer");
    this.dependsOn = ["hooks"]; // ensure api.hooks is ready
  }
  async initialize() {
    api.hooks.web.beforeRequest((req, ctx) => { /* ... */ });
    api.hooks.web.afterRequest((req, res, ctx, outcome) => { /* ... */ });
    api.hooks.ws.onConnect((connection) => { /* ... */ });
    api.hooks.ws.onMessage((connection, message) => { /* ... */ });
    api.hooks.ws.onDisconnect((connection) => { /* ... */ });
    api.hooks.mcp.onConnect((sessionId) => { /* ... */ });
    api.hooks.mcp.onMessage((sessionId) => { /* ... */ });
    api.hooks.mcp.onDisconnect((sessionId) => { /* ... */ });
    api.hooks.actions.onEnqueue((name, inputs, queue) => { /* ... */ });
    api.hooks.actions.beforeAct((name, params, connection, ctx) => { /* ... */ });
    api.hooks.actions.afterAct((name, params, connection, ctx, outcome) => { /* ... */ });
    api.hooks.resque.beforeJob((name, params, ctx) => { /* ... */ });
    api.hooks.resque.afterJob((name, params, ctx, outcome) => { /* ... */ });
  }
}
```

**HTTP request hooks** — `api.hooks.web.beforeRequest` fires at the start of every HTTP request before routing (covers static files, OAuth, MCP, metrics, and actions); `api.hooks.web.afterRequest` fires after the `Response` is built, before compression. WebSocket upgrades do not fire these hooks. A shared `RequestContext` passes from `beforeRequest` to `afterRequest` so state can be threaded through `ctx.metadata`; `afterRequest` additionally receives a `RequestOutcome` with `{ method, status, actionName?, durationMs }` describing the resolved routing decision:

```ts
api.hooks.web.beforeRequest((req, ctx) => {
  ctx.metadata.startedAt = Date.now();
});
api.hooks.web.afterRequest((_req, _res, _ctx, outcome) => {
  // outcome.actionName is undefined for static/oauth/mcp/metrics/404 paths
  recordSpan(outcome.actionName ?? "unknown", outcome.durationMs, outcome.status);
});
```

**WebSocket hooks** — `api.hooks.ws.onConnect` fires when a WebSocket is accepted (after the `Connection` is constructed); `onMessage` fires for each inbound message before parsing; `onDisconnect` fires when the socket closes, before channel presence cleanup. All three receive the persistent per-session `Connection` instance:

```ts
api.hooks.ws.onConnect((connection) => {
  logger.info(`ws connected: ${connection.id}`);
});
api.hooks.ws.onMessage((connection, _message) => {
  recordActivity(connection.id);
});
```

**MCP session hooks** — `api.hooks.mcp.onConnect` fires when an MCP session finishes initializing; `onMessage` fires before each inbound MCP request is dispatched to the transport (`sessionId` is `undefined` on the very first POST that creates a new session); `onDisconnect` fires when the transport closes. Unlike WebSocket, MCP has no persistent `Connection` per session — a fresh transient one is created per tool call — so hooks receive the stable `sessionId` string instead:

```ts
api.hooks.mcp.onConnect((sessionId) => {
  logger.info(`mcp session opened: ${sessionId}`);
});
```

**Task enqueue hook** — `api.hooks.actions.onEnqueue` fires on every `api.actions.enqueue`, `enqueueAt`, `enqueueIn`, and each per-job call inside `fanOut`. Return a replacement `TaskInputs` object to mutate the payload before it hits Redis; return `void` to leave it unchanged:

```ts
api.hooks.actions.onEnqueue((actionName, inputs, queue) => {
  return { ...inputs, _traceparent: currentTraceparent() };
});
```

**Action lifecycle hooks (cross-transport)** — `api.hooks.actions.beforeAct` and `api.hooks.actions.afterAct` fire inside `Connection.act()` for every action invocation, regardless of transport (web, websocket, task, cli, mcp, …). The `Connection` is passed so handlers can branch on `connection.type`. Unlike `hooks.web.beforeRequest` (HTTP-only) and `hooks.resque.beforeJob` (task-only), these fire across all transports with one registration. They fire after params are validated and don't run if the action isn't found or validation fails.

```ts
api.hooks.actions.beforeAct((name, params, connection, ctx) => {
  ctx.metadata.span = startSpan(`action:${name}`, {
    transport: connection.type,
  });
});
api.hooks.actions.afterAct((_name, _params, _connection, ctx, outcome) => {
  const span = ctx.metadata.span as Span;
  if (outcome.success) span.setStatus({ code: "OK" });
  else span.recordException(outcome.error as Error);
  span.end();
});
```

**Task execution hooks** — `api.hooks.resque.beforeJob` and `api.hooks.resque.afterJob` fire inside the job wrapper, bracketing the action run. They have access to the decoded action name and params (unlike the underlying `worker.on("job")` event, which only sees raw `job.args`). `afterJob` receives a unified `JobOutcome` that discriminates success from failure via `outcome.success`, so both paths reach a single handler:

```ts
api.hooks.resque.beforeJob((name, params, ctx) => {
  ctx.metadata.span = startSpan(name, params);
});
api.hooks.resque.afterJob((_name, _params, ctx, outcome) => {
  const span = ctx.metadata.span as Span;
  if (outcome.success) span.setStatus({ code: "OK" });
  else span.recordException(outcome.error as Error);
  span.end();
});
```

All hook types (`RequestContext`, `RequestOutcome`, `BeforeRequestHook`, `AfterRequestHook`, `OnConnectHook`, `OnMessageHook`, `OnDisconnectHook`, `OnMcpConnectHook`, `OnMcpMessageHook`, `OnMcpDisconnectHook`, `OnEnqueueHook`, `ActContext`, `ActOutcome`, `BeforeActHook`, `AfterActHook`, `JobContext`, `JobOutcome`, `BeforeJobHook`, `AfterJobHook`) are exported from `"keryx"`. Hooks run sequentially in registration order; thrown errors propagate (a throw in `beforeRequest` aborts the request, a throw in `beforeAct` fails the action, a throw in `beforeJob` fails the job).

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
