---
description: First-party plugins maintained by the Keryx team that add opt-in functionality to your application.
---

# Plugins

The Keryx team maintains a set of first-party plugins under the `@keryxjs` npm scope. Each plugin is a standalone package you install alongside `keryx` — they're opt-in and independent.

## Available Plugins

| Plugin | Package | Description |
|--------|---------|-------------|
| [Tracing](/plugins/tracing) | `@keryxjs/tracing` | OpenTelemetry distributed tracing (OTLP) for HTTP, actions, tasks, Redis, and Drizzle |
| [Resque Admin](/plugins/resque-admin) | `@keryxjs/resque-admin` | Web dashboard and API for monitoring Redis, queues, workers, failed jobs, and locks |
| [CSRF](/plugins/csrf) | `@keryxjs/csrf` | Per-session CSRF tokens and middleware to protect state-changing endpoints |

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
