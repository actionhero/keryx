---
description: First-party plugins maintained by the Keryx team that add opt-in functionality to your application.
---

# Plugins

The Keryx team maintains a set of first-party plugins under the `@keryxjs` npm scope. Each plugin is a standalone package you install alongside `keryx` — they're opt-in and independent.

## Available Plugins

| Plugin | Package | Description |
|--------|---------|-------------|
| [Observability](/plugins/observability) | `@keryxjs/observability` | OpenTelemetry metrics (Prometheus) and distributed tracing (OTLP) for HTTP, WebSocket, actions, and tasks |
| [Resque Admin](/plugins/resque-admin) | `@keryxjs/resque-admin` | Web dashboard and API for monitoring Redis, queues, workers, failed jobs, and locks |

## Using a Plugin

Install the package, register it in your config, and you're done:

```ts
// config/plugins.ts
import { resqueAdminPlugin } from "@keryxjs/resque-admin";

export default {
  plugins: [resqueAdminPlugin],
};
```

The framework loads plugins during initialization — their actions, initializers, and config defaults are discovered automatically.

## Building Your Own

Want to create a plugin? See the [Plugins guide](/guide/plugins) for the `KeryxPlugin` interface, what plugins can provide, and how to build and publish one.
