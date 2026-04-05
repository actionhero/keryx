---
description: Initializers are lifecycle components that set up services and attach them to the global API singleton.
---

# Initializers

Initializers are the backbone of the server's boot process. They're lifecycle components that set up services — connecting to databases, starting Redis, registering actions, configuring the task queue — in a controlled, priority-ordered sequence.

If you've worked with the original ActionHero, initializers will feel familiar. The big difference here is the TypeScript integration: each initializer uses module augmentation to extend the `API` interface with its namespace, so `api.db`, `api.redis`, `api.actions` are all fully typed throughout the codebase.

## Lifecycle

The server goes through three phases:

```
initialize()  →  start()  →  [running]  →  stop()
```

- **`initialize()`** — set up your namespace object and return it. This is where you define the shape of what gets attached to `api`.
- **`start()`** — connect to external services (databases, Redis, etc.). By this point, all initializers have been loaded, so you can reference other namespaces.
- **`stop()`** — clean up. Close connections, flush buffers, shut down gracefully.

## Priority Ordering

Each initializer has three priority values. Lower numbers run first:

| Initializer     | Load Priority | What it does                                       |
| --------------- | ------------- | -------------------------------------------------- |
| `connections`   | 1             | Connection pool management                         |
| `signals`       | 1             | SIGINT/SIGTERM graceful shutdown handlers          |
| `process`       | 2             | Process metadata (name, boot time)                 |
| `observability` | 50            | OpenTelemetry metrics + Prometheus scrape endpoint |
| `actions`       | 100           | Discovers and registers all actions                |
| `channels`      | 100           | Discovers and registers PubSub channels            |
| `db`            | 100           | Sets up Drizzle ORM + connection pool              |
| `swagger`       | 150           | Parses source code for OpenAPI schemas             |
| `oauth`         | 175           | OAuth 2.1 provider for MCP auth                    |
| `redis`         | 200           | Redis client connection                            |
| `mcp`           | 200           | MCP server — exposes actions as tools              |
| `resque`        | 250           | Background task queue                              |
| `servers`       | 800           | Auto-discovers and loads transport servers         |
| `session`       | 1000          | Redis-backed session management                    |
| `pubsub`        | 1000          | Redis PubSub for real-time messaging               |
| `application`   | 1000          | App-specific setup (default user, etc.)            |

The defaults are `1000` for all three priorities (`loadPriority`, `startPriority`, `stopPriority`), so core framework initializers use lower values to ensure they run first.

## The Module Augmentation Pattern

This is the part that makes the type system work. Each initializer extends the `API` interface so TypeScript knows what's available on the `api` singleton:

```ts
import { Initializer } from "../classes/Initializer";
import { api, logger } from "../api";

const namespace = "db";

// This is the magic — tells TypeScript that api.db exists and what type it is
declare module "../classes/API" {
  export interface API {
    [namespace]: Awaited<ReturnType<DB["initialize"]>>;
  }
}

export class DB extends Initializer {
  constructor() {
    super(namespace);
    this.loadPriority = 100;
    this.startPriority = 100;
    this.stopPriority = 910;
  }

  async initialize() {
    const dbContainer = {} as {
      db: ReturnType<typeof drizzle>;
      client: InstanceType<typeof SQL>;
    };
    return Object.assign(
      {
        generateMigrations: this.generateMigrations,
        clearDatabase: this.clearDatabase,
      },
      dbContainer,
    );
  }

  async start() {
    api.db.client = new SQL({
      url: config.database.connectionString,
    });
    api.db.db = drizzle({ client: api.db.client });
    // migrations run here if configured...
  }

  async stop() {
    await api.db.client.close();
  }
}
```

The return value of `initialize()` becomes `api.db` — and that type flows everywhere. You get autocomplete in your actions, your tests, your ops layer… everywhere.

## The `api` Singleton

The `api` object lives on `globalThis` and accumulates namespaces as initializers run:

```ts
api.db; // Drizzle ORM + Postgres pool
api.redis; // Redis client
api.actions; // Action registry + fan-out
api.session; // Session manager
api.pubsub; // Redis PubSub
api.swagger; // OpenAPI schema cache
api.oauth; // OAuth 2.1 provider
api.mcp; // MCP server
api.resque; // Background task queue
```

Every namespace is typed via module augmentation, so you never have to cast or guess at the shape of `api.db` or `api.redis`.

## Auto-Discovery

Initializers are auto-discovered. Drop a `.ts` file in `initializers/`, export a class that extends `Initializer`, and it'll get picked up on boot. Files prefixed with `.` are skipped — useful for temporarily disabling an initializer without deleting it.

## Run Modes

The server can boot in two modes:

- **`RUN_MODE.SERVER`** (default) — starts all transports (web server, task workers, etc.)
- **`RUN_MODE.CLI`** — skips transport-specific setup; used when running actions from the command line

Each initializer declares which run modes it supports via `runModes`. Most initializers run in both modes, but transport-specific ones (like the web server) only run in `SERVER` mode. This means `./keryx.ts "status" -q` can execute the action without binding to a port.

## Swagger / OpenAPI Schema Generation

The `swagger` initializer (priority 150) generates JSON Schema definitions for action response types using TypeScript AST parsing via [ts-morph](https://github.com/dsherret/ts-morph). It scans all action source files, finds the `run()` method return type, and converts it to JSON Schema.

Schemas are cached in `<rootDir>/.cache/swagger-schemas.json` and regenerated when action source files change (detected via content hashing). These schemas are used by the web server to serve a Swagger/OpenAPI-compatible API description.

## Process Lifecycle

The `api` singleton manages the full lifecycle:

```ts
await api.start(); // initialize + start all initializers
await api.stop(); // stop all initializers in reverse priority
await api.restart(); // stop + start (with flap prevention)
```

`api.restart()` includes flap prevention — if a restart is already in progress, the second call is a no-op. This prevents cascading restart loops.

Signal handlers are registered by the `signals` initializer:

- **SIGINT** (Ctrl+C) — triggers graceful shutdown via `api.stop()`
- **SIGTERM** — same graceful shutdown

The shutdown process stops initializers in `stopPriority` order (lowest first), so channels and the MCP server stop before the web server, which stops before the database pool and Redis are closed.
