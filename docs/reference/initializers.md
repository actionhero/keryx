---
description: Initializer class definition and the module augmentation pattern.
---

# Initializer

Source: `packages/keryx/classes/Initializer.ts`

Initializers are the lifecycle components that boot up your server. They run in dependency order — derived from each initializer's `dependsOn` field via a topological sort — during `initialize → start → stop`, and each one attaches its namespace to the global `api` singleton.

## Class Definition

```ts
abstract class Initializer {
  /** The name of the initializer — also used as the api namespace key */
  name: string;

  /**
   * Names of other initializers whose initialize() and start() must complete
   * before this one runs. Also determines stop order (dependents stop first).
   * Unknown names and cycles cause a startup error.
   * Default: []
   */
  dependsOn: string[];

  /** Which run modes this initializer activates in */
  runModes: RUN_MODE[];

  constructor(name: string);

  /** Set up namespace object and return it. Attaches to api[name]. */
  async initialize?(): Promise<any>;

  /** Connect to external services. All dependencies are initialized and started by this point. */
  async start?(): Promise<any>;

  /** Clean up — close connections, flush buffers. */
  async stop?(): Promise<any>;
}
```

## RUN_MODE

Initializers can be scoped to specific run modes. By default, they run in both:

```ts
enum RUN_MODE {
  CLI = "cli",
  SERVER = "server",
}
```

## Module Augmentation Pattern

This is how each initializer makes `api.myNamespace` fully typed. You declare the type on the `API` interface, and TypeScript knows what's there:

```ts
const namespace = "db";

declare module "../classes/API" {
  export interface API {
    [namespace]: Awaited<ReturnType<DB["initialize"]>>;
  }
}
```

The return type of `initialize()` becomes `api[namespace]` — autocomplete, type checking, the works.

## Dependency Reference

Each framework initializer declares what it depends on:

| Initializer     | `dependsOn`                                              |
| --------------- | -------------------------------------------------------- |
| `connections`   | `[]`                                                     |
| `signals`       | `[]`                                                     |
| `process`       | `[]`                                                     |
| `db`            | `[]`                                                     |
| `redis`         | `[]`                                                     |
| `hooks`         | `[]`                                                     |
| `actions`       | `["hooks"]`                                              |
| `observability` | `["hooks", "actions", "connections"]`                    |
| `swagger`       | `["actions"]`                                            |
| `session`       | `["redis"]`                                              |
| `oauth`         | `["redis", "actions"]`                                   |
| `pubsub`        | `["redis", "connections"]`                               |
| `channels`      | `["redis", "pubsub"]`                                    |
| `servers`       | `["actions", "hooks"]`                                   |
| `mcp`           | `["hooks", "actions", "oauth", "connections", "pubsub"]` |
| `resque`        | `["redis", "actions", "process", "hooks"]`               |

The resolved graph is rendered to the logs at startup. See the [initializers guide](../guide/initializers.md) for sample output.
