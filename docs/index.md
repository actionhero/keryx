---
layout: home
description: The fullstack TypeScript framework for MCP and APIs — transport-agnostic actions for HTTP, WebSocket, CLI, background tasks, and MCP, built on Bun.
hero:
  name: Keryx
  text: The Fullstack TypeScript Framework for MCP and APIs
  tagline: One action class. Five transports. Your API is automatically an MCP server for AI agents, a WebSocket handler, a CLI tool, and a background task runner. Built on Bun, powered by Zod.
  image:
    src: /images/hearald.svg
    alt: Keryx herald
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: API Reference
      link: /reference/actions
    - theme: sponsor
      text: LLMs.txt
      link: /llms.txt
features:
  - icon: "\U0001F916"
    title: MCP-Native
    details: Every action is automatically an MCP tool. AI agents authenticate via built-in OAuth 2.1, get typed errors, and call the same validated endpoints your HTTP clients use — zero extra configuration.
  - icon: "\U0001F500"
    title: One Action, Every Transport
    details: Write your controller once — HTTP endpoint, WebSocket handler, CLI command, background task, and MCP tool. Same validation, same middleware, same response.
  - icon: "\U0001F6E1\uFE0F"
    title: Zod Validation
    details: Type-safe inputs with automatic validation. Your Zod schemas generate OpenAPI docs, power CLI --help, and validate WebSocket params — all from one definition.
  - icon: "\u26A1"
    title: Built on Bun
    details: Native TypeScript, fast startup, built-in test runner, no compilation step. Bun handles bundling, testing, and module resolution out of the box.
  - icon: "\U0001F4E1"
    title: Real-Time Channels
    details: PubSub over Redis with middleware-based authorization. Define channel patterns, control who can subscribe, and broadcast to WebSocket clients.
  - icon: "\u2699\uFE0F"
    title: Background Tasks & Fan-Out
    details: Built-in Resque workers with a fan-out pattern for distributing work across child jobs. Track progress and collect results automatically.
  - icon: "\U0001F5C4\uFE0F"
    title: Drizzle ORM
    details: First-class database support with auto-migrations and type-safe schemas. No separate ORM plugin needed — it's part of the stack.
  - icon: "\U0001F4CA"
    title: Observability & Structured Logging
    details: Built-in OpenTelemetry metrics, plus structured logging for log aggregation. Correlation IDs trace requests across services.
---

## One Action, Every Transport

This is one action:

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
{
  "messageType": "action",
  "action": "user:create",
  "params": {
    "name": "Evan",
    "email": "evan@example.com",
    "password": "secret123"
  }
}
```

**CLI** — flags are generated from the Zod schema automatically:

```bash
./keryx.ts "user:create" --name Evan --email evan@example.com --password secret123 -q | jq
```

**Background Task** — enqueued to a Resque worker via Redis:

```ts
await api.actions.enqueue("user:create", {
  name: "Evan",
  email: "evan@example.com",
  password: "secret123",
});
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

## Why Keryx?

Most backends start simple — an HTTP framework — then bolt on a WebSocket server, a CLI tool, a job queue, and now an MCP layer. Each one has its own handler, its own validation, its own auth. You end up maintaining five implementations of the same logic.

Keryx flips that: write your controller once, and the framework delivers it across every transport.

| Feature             | Keryx | Hono    | Elysia | NestJS   | FastAPI | Django   |
| ------------------- | ----- | ------- | ------ | -------- | ------- | -------- |
| HTTP                | yes   | yes     | yes    | yes      | yes     | yes      |
| WebSocket           | yes   | adapter | yes    | yes      | yes     | channels |
| CLI commands        | yes   | —       | —      | limited  | —       | yes      |
| Background tasks    | yes   | —       | —      | Bull     | Celery  | Celery   |
| MCP tools           | yes   | —       | —      | —        | —       | —        |
| Unified controller  | yes   | —       | —      | —        | —       | —        |
| Type-safe responses | yes   | yes     | yes    | partial  | yes     | —        |
| OAuth 2.1 built-in  | yes   | —       | —      | Passport | —       | allauth  |
| Per-session agents  | yes   | —       | —      | —        | —       | —        |

[See detailed comparisons →](/guide/comparisons)

The MCP SDK gives you the protocol. Keryx gives you the framework — actions, validation, middleware, auth, database, and background tasks alongside your MCP tools.

## Built for AI Agents

Keryx is the only TypeScript framework where your API is automatically an MCP server. No separate tool definitions, no duplicated auth, no schema mapping.

- **Zero-config tool registration** — write an action, it's an MCP tool. The Zod schema becomes the tool's input schema automatically.
- **OAuth 2.1 + PKCE built-in** — agents authenticate the same way browser clients do. One auth layer, not two.
- **Dynamic OAuth forms** — login and signup pages are generated from your Zod schemas. Change a field, the form updates.
- **Per-session MCP servers** — each agent connection gets isolated state. No cross-session leaks.
- **Typed errors** — agents get structured `ErrorType` values, not generic failure messages. They can distinguish validation errors from auth failures.
- **Real-time notifications** — PubSub events are forwarded to connected agents as MCP logging messages.
- **`llms.txt` included** — AI agents and LLMs can discover optimized Markdown documentation at [`/llms.txt`](/llms.txt), no scraping needed.

Claude Desktop, VS Code Copilot, Cursor, Windsurf, and any other MCP client can discover and call your actions out of the box.

[Building for AI Agents →](/guide/agents)

## Why Bun?

- **Native TypeScript** — no compilation step, no `tsconfig` gymnastics
- **Built-in test runner** — `bun test` with watch mode, no extra dependencies
- **Fast startup** — sub-second cold starts for dev and production
- **Module resolution that works** — ESM, CommonJS, and `.ts` imports without configuration
- **`fetch` included natively** — great for testing your own API

## Quick Start

```bash
bunx keryx new my-app
cd my-app
cp .env.example .env
bun install
bun dev
```

Requires Bun, PostgreSQL, and Redis. See the [Getting Started guide](/guide/) for full setup instructions.

## Built With

[Bun](https://bun.sh) · [Zod](https://zod.dev) · [Drizzle](https://orm.drizzle.team) · [Redis](https://redis.io) · [PostgreSQL](https://www.postgresql.org) · [OpenTelemetry](https://opentelemetry.io)
