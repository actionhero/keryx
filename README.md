# Keryx

<p align="center"><strong>The fullstack TypeScript framework for MCP and APIs.</strong></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/actionhero/keryx/main/docs/public/images/horn.svg" alt="Keryx" width="200" />
</p>

[![Test](https://github.com/actionhero/keryx/actions/workflows/test.yaml/badge.svg)](https://github.com/actionhero/keryx/actions/workflows/test.yaml)

## What is this Project?

This is a ground-up rewrite of [ActionHero](https://www.actionherojs.com), built on [Bun](https://bun.sh). I still believe in the core ideas behind ActionHero — it was an attempt to take the best ideas from Rails and Node.js and shove them together — but the original framework needed a fresh start with Bun, Zod, Drizzle, and first-class MCP support.

The big idea: **write your controller once, and it works everywhere**. A single action class handles HTTP requests, WebSocket messages, CLI commands, background tasks, and MCP tool calls — same inputs, same validation, same middleware, same response. No duplication.

That includes AI agents. Every action is automatically an MCP tool — agents authenticate via built-in OAuth 2.1, get typed errors, and call the same validated endpoints your HTTP clients use. No separate MCP server, no duplicated schemas.

### One Action, Every Transport

Here's what that looks like in practice. This is one action:

```ts
export class UserCreate implements Action {
  name = "user:create";
  description = "Create a new user";
  inputs = z.object({
    name: z.string().min(3),
    email: z.string().email(),
    password: secret(z.string().min(8)),
  });
  web = { route: "/user", method: HTTP_METHOD.PUT };
  task = { queue: "default" };

  async run(params: ActionParams<UserCreate>) {
    const user = await createUser(params);
    return { user: serializeUser(user) };
  }
}
```

That one class gives you:

**HTTP** — `PUT /api/user` with JSON body, query params, or form data:
```bash
curl -X PUT http://localhost:8080/api/user \
  -H "Content-Type: application/json" \
  -d '{"name":"Evan","email":"evan@example.com","password":"secret123"}'
```

**WebSocket** — send a JSON message over an open connection:
```json
{ "messageType": "action", "action": "user:create",
  "params": { "name": "Evan", "email": "evan@example.com", "password": "secret123" } }
```

**CLI** — flags are generated from the Zod schema automatically:
```bash
./keryx.ts "user:create" --name Evan --email evan@example.com --password secret123 -q | jq
```

**Background Task** — enqueued to a Resque worker via Redis:
```ts
await api.actions.enqueue("user:create", { name: "Evan", email: "evan@example.com", password: "secret123" });
```

**MCP** — exposed as a tool for AI agents automatically:
```json
{
  "mcpServers": {
    "my-app": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

Same validation, same middleware chain, same `run()` method, same response shape. The only thing that changes is how the request arrives and how the response is delivered.

That's it. The agent can now discover all your actions as tools, authenticate via OAuth, and call them with full type validation.

### Key Components

- **MCP-native** — every action is an MCP tool with OAuth 2.1 auth, typed errors, and per-session isolation
- **Transport-agnostic Actions** — HTTP, WebSocket, CLI, background tasks, and MCP from one class
- **Zod input validation** — type-safe params with automatic error responses and OpenAPI generation
- **Built-in background tasks** via [node-resque](https://github.com/actionhero/node-resque), with a [fan-out pattern](#fan-out-tasks) for parallel job processing
- **Strongly-typed frontend integration** — `ActionResponse<MyAction>` gives the frontend type-safe API responses, no code generation needed
- **Drizzle ORM** with auto-migrations (replacing the old `ah-sequelize-plugin`)
- **Companion Vite + React frontend** as a separate application (replacing `ah-next-plugin`)
- **Streaming responses** — SSE and chunked binary streaming via `StreamingResponse`, with per-transport behavior (HTTP, WebSocket, MCP)
- **Pagination helpers** — `paginationInputs()` Zod mixin + `paginate()` utility for standardized paginated responses
- **Database transactions** — `withTransaction()` and `TransactionMiddleware` for automatic commit/rollback across action execution
- **Redis caching patterns** — cache-aside and response-level cache middleware using the built-in ioredis connection

### Why Bun?

TypeScript is still the best language for web APIs. But Node.js has stalled — Bun is moving faster and includes everything we need out of the box:

- Native TypeScript — no compilation step
- Built-in test runner
- Module resolution that just works
- Fast startup and an excellent packager
- `fetch` included natively — great for testing

## Project Structure

- **root** — a slim `package.json` wrapping the workspaces. `bun install` and `bun dev` work here, but you need to `cd` into each workspace for tests.
- **packages/keryx** — the framework package (publishable)
- **example/backend** — the example backend application
- **example/frontend** — the example Vite + React frontend
- **docs** — the [documentation site](https://keryxjs.com)

## Quick Start

Create a new project:

```bash
bunx keryx new my-app
cd my-app
cp .env.example .env
bun install
bun dev
```

Requires Bun, PostgreSQL, and Redis. See the [Getting Started guide](https://keryxjs.com/guide/) for full setup instructions.

### Developing the framework itself

If you're contributing to Keryx, clone the monorepo instead:

```bash
git clone https://github.com/actionhero/keryx.git
cd keryx
bun install
cp example/backend/.env.example example/backend/.env
cp example/frontend/.env.example example/frontend/.env
bun dev
```

## Production Builds

```bash
bun compile
# set NODE_ENV=production in .env
bun start
```

## Databases and Migrations

We use [Drizzle](https://orm.drizzle.team) as the ORM. Migrations are derived from schemas — edit your schema files in `schema/*.ts`, then generate and apply:

```bash
cd example/backend && bun run migrations
# restart the server — pending migrations auto-apply
```

## Actions, CLI Commands, and Tasks

Unlike the original ActionHero, we've removed the distinction between actions, CLI commands, and tasks. They're all the same thing now. You can run any action from the CLI, schedule any action as a background task, call any action via HTTP or WebSocket, and expose any action as an MCP tool for AI agents. Same input validation, same responses, same middleware.

### Web Actions

Add a `web` property to expose an action as an HTTP endpoint. Routes support `:param` path parameters and RegExp patterns — the route lives on the action itself, no separate `routes.ts` file:

```ts
web = { route: "/user/:id", method: HTTP_METHOD.GET };
```

### WebSocket Actions

Enabled by default. Clients send JSON messages with `{ messageType: "action", action: "user:create", params: { ... } }`. The server validates params through the same Zod schema and sends the response back over the socket. WebSocket connections also support channel subscriptions for real-time PubSub.

### CLI Actions

Enabled by default. Every action is registered as a CLI command via [Commander](https://github.com/tj/commander.js). The Zod schema generates `--flags` and `--help` text automatically:

```bash
./keryx.ts "user:create" --name evan --email "evantahler@gmail.com" --password password -q | jq
```

The `-q` flag suppresses logs so you get clean JSON. Use `--help` on any action to see its params.

### Task Actions

Add a `task` property to schedule an action as a background job. A `queue` is required, and `frequency` is optional for recurring execution:

```ts
task = { queue: "default", frequency: 1000 * 60 * 60 }; // every hour
```

### MCP Actions

When the MCP server is enabled (`MCP_SERVER_ENABLED=true`), every action is automatically registered as an [MCP](https://modelcontextprotocol.io) tool. AI agents and LLM clients (Claude Desktop, VS Code, etc.) can discover and call your actions through the standard Model Context Protocol. Actions can also be exposed as MCP **resources** (URI-addressed data) and **prompts** (named templates) via `mcp.resource` and `mcp.prompt`.

Action names are converted to valid MCP tool names by replacing `:` with `-` (e.g., `user:create` becomes `user-create`). The action's Zod schema is converted to JSON Schema for tool and prompt parameter definitions.

To exclude an action from MCP tools:

```ts
mcp = { tool: false };
```

To expose an action as an MCP resource or prompt:

```ts
// Resource — clients fetch this by URI
mcp = { tool: false, resource: { uri: "myapp://status", mimeType: "application/json" } };

// Prompt — clients invoke this as a named template
mcp = { tool: false, prompt: { title: "Greeting" } };
```

OAuth 2.1 with PKCE is used for authentication — MCP clients go through a browser-based login flow, and subsequent tool calls carry a Bearer token tied to the authenticated user's session.

### Fan-Out Tasks

A parent task can distribute work across many child jobs using `api.actions.fanOut()` for parallel processing. Results are collected automatically in Redis. See the [Tasks guide](https://keryxjs.com/guide/tasks) for full API and examples.

### Streaming Responses

Actions can stream data by returning a `StreamingResponse`. The framework handles SSE, chunked binary, and cross-transport behavior automatically:

```ts
async run(params: { prompt: string }) {
  const sse = StreamingResponse.sse();

  (async () => {
    try {
      for await (const token of callLLM(params.prompt)) {
        sse.send(token, { event: "token" });
      }
      sse.close();
    } catch (e) {
      sse.sendError(String(e));
    }
  })();

  return sse;
}
```

Over HTTP this is native SSE; over WebSocket each chunk becomes an incremental message; over MCP chunks are forwarded as logging messages. See the [Streaming guide](https://keryxjs.com/guide/streaming) for full details.

## Coming from ActionHero?

Keryx keeps the core ideas but rewrites everything on Bun with first-class MCP support. The biggest changes: unified controllers (actions = tasks = CLI commands = MCP tools), separate frontend/backend applications, Drizzle ORM, and MCP as a first-class transport.

See the full [migration guide](https://keryxjs.com/guide/from-actionhero) for details.

## Production Deployment

Each application has its own `Dockerfile`, and a `docker-compose.yml` runs them together. You probably won't use this exact setup in production, but it shows how the pieces fit together.

## Documentation

Full docs at [keryxjs.com](https://keryxjs.com), including:
- [Getting Started](https://keryxjs.com/guide/)
- [Actions Guide](https://keryxjs.com/guide/actions)
- [Streaming](https://keryxjs.com/guide/streaming)
- [Caching](https://keryxjs.com/guide/caching)
- [API Reference](https://keryxjs.com/reference/actions)

<p align="center">
  <img src="https://raw.githubusercontent.com/actionhero/keryx/main/docs/public/images/lion-standing.svg" alt="Keryx lion" width="120" />
</p>
