---
description: Initializers are lifecycle components that set up services and attach them to the global API singleton.
---

# Initializers

Initializers are the backbone of the server's boot process. They're lifecycle components that set up services — connecting to databases, starting Redis, registering actions, configuring the task queue — in a controlled, dependency-ordered sequence.

If you've worked with the original ActionHero, initializers will feel familiar. The big difference here is the TypeScript integration: each initializer uses module augmentation to extend the `API` interface with its namespace, so `api.db`, `api.redis`, `api.actions` are all fully typed throughout the codebase.

## Lifecycle

The server goes through three phases:

```
initialize()  →  start()  →  [running]  →  stop()
```

- **`initialize()`** — set up your namespace object and return it. This is where you define the shape of what gets attached to `api`.
- **`start()`** — connect to external services (databases, Redis, etc.). By this point, all initializers have been loaded, so you can reference other namespaces.
- **`stop()`** — clean up. Close connections, flush buffers, shut down gracefully.

## Dependency Ordering

Each initializer declares the names of other initializers it depends on via `dependsOn: string[]`. At boot the framework performs a topological sort so every dependency's `initialize()` and `start()` run before the dependent's. The `stop()` phase runs in the reverse order so dependents shut down before their dependencies.

```ts
export class Session extends Initializer {
  constructor() {
    super("session");
    this.dependsOn = ["redis"]; // session needs api.redis before it can initialize
  }
}
```

Unknown dependency names or cycles cause a startup failure with a clear, actionable error message.

| Initializer     | `dependsOn`                                              | What it does                                       |
| --------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `connections`   | `[]`                                                     | Connection pool management                         |
| `signals`       | `[]`                                                     | SIGINT/SIGTERM graceful shutdown handlers          |
| `process`       | `[]`                                                     | Process metadata (name, boot time)                 |
| `db`            | `[]`                                                     | Sets up Drizzle ORM + connection pool              |
| `redis`         | `[]`                                                     | Redis client connection                            |
| `hooks`         | `[]`                                                     | Central registry for framework lifecycle hooks     |
| `actions`       | `["hooks"]`                                              | Discovers and registers all actions                |
| `observability` | `["hooks", "actions", "connections"]`                    | OpenTelemetry metrics + Prometheus scrape endpoint |
| `swagger`       | `["actions"]`                                            | Parses source code for OpenAPI schemas             |
| `session`       | `["redis"]`                                              | Redis-backed session management                    |
| `oauth`         | `["redis", "actions"]`                                   | OAuth 2.1 provider for MCP auth                    |
| `pubsub`        | `["redis", "connections"]`                               | Redis PubSub for real-time messaging               |
| `channels`      | `["redis", "pubsub"]`                                    | Discovers and registers PubSub channels            |
| `servers`       | `["actions", "hooks"]`                                   | Auto-discovers and loads transport servers         |
| `mcp`           | `["hooks", "actions", "oauth", "connections", "pubsub"]` | MCP server — exposes actions as tools              |
| `resque`        | `["redis", "actions", "process", "hooks"]`               | Background task queue                              |

When the server starts, it renders the resolved graph to the logs so the order is visible at a glance:

```
--- 🔗  Initializer dependency graph ---
  01  connections
  02  signals
  03  process
  04  db
  05  redis
  06  hooks
  07  actions        ← hooks
  08  observability  ← hooks, actions, connections
  09  swagger        ← actions
  10  session        ← redis
  11  oauth          ← redis, actions
  12  pubsub         ← redis, connections
  13  channels       ← redis, pubsub
  14  servers        ← actions, hooks
  15  mcp            ← hooks, actions, oauth, connections, pubsub
  16  resque         ← redis, actions, process, hooks
```

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
    // no dependencies — Postgres connection stands alone
  }

  async initialize() {
    const dbContainer = {} as {
      db: ReturnType<typeof drizzle>;
      pool: Pool;
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
    api.db.pool = new Pool({
      connectionString: config.database.connectionString,
    });
    api.db.db = drizzle(api.db.pool);
    // migrations run here if configured...
  }

  async stop() {
    await api.db.pool.end();
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

The `swagger` initializer (depends on `actions`) generates JSON Schema definitions for action response types using TypeScript AST parsing via [ts-morph](https://github.com/dsherret/ts-morph). It scans all action source files, finds the `run()` method return type, and converts it to JSON Schema.

Schemas are cached in `<rootDir>/.cache/swagger-schemas.json` and regenerated when action source files change (detected via content hashing). These schemas are used by the web server to serve a Swagger/OpenAPI-compatible API description.

## Process Lifecycle

The `api` singleton manages the full lifecycle:

```ts
await api.start(); // initialize + start all initializers
await api.stop(); // stop all initializers in reverse dependency order
await api.restart(); // stop + start (with flap prevention)
```

`api.restart()` includes flap prevention — if a restart is already in progress, the second call is a no-op. This prevents cascading restart loops.

Signal handlers are registered by the `signals` initializer:

- **SIGINT** (Ctrl+C) — triggers graceful shutdown via `api.stop()`
- **SIGTERM** — same graceful shutdown

The shutdown process walks the dependency graph in reverse, so dependents stop before the initializers they depend on — channels and the MCP server stop before the web server, which stops before the database pool and Redis are closed.
