---
description: Get up and running with Keryx — prerequisites, installation, and your first dev server.
---

# Getting Started

Keryx is the fullstack TypeScript framework for MCP and APIs. It's the spiritual successor to [ActionHero](https://www.actionherojs.com), rebuilt from scratch on [Bun](https://bun.sh) with Zod for validation, Drizzle for the ORM, and a Vite + React frontend. The core ideas are the same — transport-agnostic actions, built-in background tasks, strong typing between frontend and backend — but the tooling and scope are different.

Write your controller logic once, and it works as an HTTP endpoint, WebSocket handler, CLI command, background task, and MCP tool — all at the same time. Enable `MCP_SERVER_ENABLED=true` and AI agents can discover and call those same actions as MCP tools.

The name **Keryx** (κῆρυξ) comes from ancient Greek, meaning "herald" or "messenger" — the person who carried proclamations between gods and mortals. It fits: your actions are the message, and Keryx delivers them across every transport.

## Prerequisites

You'll need these running locally:

- [Bun](https://bun.sh) (latest)
- [PostgreSQL](https://www.postgresql.org/)
- [Redis](https://redis.io/)

## Installation (macOS)

```bash
# install bun
curl -fsSL https://bun.sh/install | bash

# install postgres and redis
brew install postgresql redis
brew services start postgresql
brew services start redis
```

## Create a New Project

```bash
bunx keryx new my-app
cd my-app
cp .env.example .env
createdb my-app
createdb my-app-test
bun install
```

The generated `.env` points `DATABASE_URL` at a database named after your project, and `DATABASE_URL_TEST` at `<project>-test` — so create both before starting the server. `keryx new` prints these same steps when it finishes.

The `keryx new` command will prompt you for a project name and optional features (database setup, example action). You can also skip prompts with `--no-interactive`:

```bash
bunx keryx new my-app --no-interactive
```

## Run the Dev Server

```bash
bun dev
```

That's it. The backend will start with hot reload — edit a file, save it, and see the change immediately.

## Project Structure

A new Keryx project looks like this:

```
my-app/
├── actions/        # Transport-agnostic controllers
├── channels/       # WebSocket PubSub channels
├── drizzle/        # Generated migration SQL
├── initializers/   # Lifecycle components (DB, Redis, etc.)
├── middleware/     # Action and channel middleware
├── schema/         # Drizzle ORM table definitions
├── index.ts        # Sets api.rootDir, re-exports framework types
├── keryx.ts        # CLI entry point
├── .env.example    # Environment variable template
└── package.json
```

Actions, initializers, and channels are auto-discovered from their directories — just drop in a `.ts` file and the framework picks it up.

## Generate Components

Use the CLI generator to scaffold new components with boilerplate:

```bash
bunx keryx generate action user:create
bunx keryx g initializer cache        # "g" is a shorthand alias
```

This creates the component file and a matching test file. See the [CLI guide](/guide/cli) for all generator types and options.

## What's Next

- [Actions](/guide/actions) — the core concept. Everything is an action.
- [Initializers](/guide/initializers) — how the server boots up and connects to services
- [Tasks](/guide/tasks) — background jobs and the fan-out pattern
- [Configuration](/guide/config) — environment-based config with per-env overrides
- [Building for AI Agents](/guide/agents) — expose your actions as MCP tools for Claude, Cursor, and other AI clients
- [Caching](/guide/caching) — Redis-backed caching helpers and invalidation patterns
- [Testing](/guide/testing) — real HTTP requests against a real server, no mocks
- [Deployment](/guide/deployment) — running Keryx in production
- [Coming from ActionHero](/guide/from-actionhero) — what changed, and how concepts map across
