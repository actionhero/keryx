# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The fullstack TypeScript framework for MCP and APIs, built on Bun. Spiritual successor to ActionHero. Monorepo with workspaces under `packages/keryx/` (publishable framework), `packages/plugins/*` (first-party plugins like `tracing` and `resque-admin`), `example/backend/` (example API server), `example/frontend/` (Vite + React app), and `docs/` (VitePress site). The core idea: **Actions are the universal controller** - they serve as HTTP endpoints, WebSocket handlers, CLI commands, background tasks, and MCP tools simultaneously.

## Monorepo Structure

```
keryx/
  packages/
    keryx/                 # Framework package (publishable as "keryx")
      classes/             # API, Action, Channel, Connection, Initializer, etc.
      initializers/        # Framework initializers (db, redis, actions, servers, etc.)
      servers/             # WebServer (Bun.serve)
      actions/             # Built-in actions (status, swagger)
      config/              # Modular config with env overrides (logger, observability, server/web)
      middleware/          # Generic middleware (rateLimit)
      util/                # Helpers (glob, cli, config, zodMixins, oauth, generate, web*)
      templates/           # OAuth HTML + SVG + CLI generator mustache templates
      lua/                 # Redis Lua scripts
      api.ts               # Singleton + exports
      index.ts             # Package entry point (re-exports)
      keryx.ts             # CLI entry (start, generate, upgrade)
      __tests__/           # Framework-level tests
    plugins/               # First-party plugins (each is its own workspace)
      tracing/             # OpenTelemetry tracing plugin
      resque-admin/        # Web UI for inspecting Resque queues
  example/
    backend/               # Example app using keryx
      actions/             # App actions (user, session, message, channel, files)
      initializers/        # App initializer (application.ts)
      ops/                 # Business logic (UserOps, MessageOps)
      schema/              # Drizzle ORM table definitions
      channels/            # WebSocket channels
      middleware/           # App middleware (session, channel auth)
      drizzle/             # Migration SQL files
      util/                # App-specific zodMixins
      index.ts             # Sets api.rootDir, re-exports from "keryx"
      keryx.ts             # App CLI entry
      __tests__/           # App-specific tests
    frontend/              # Vite + React + Bootswatch frontend
  docs/                    # VitePress documentation site
```

## Development Environment

This is a Bun-based project. Use `bun` instead of `npm` for all package management commands (install, run, test). Never use symlinks for node_modules resolution - just run `bun install`.

## Environment Setup

Example backend requires an `.env` file. In a fresh clone or new git worktree:

```bash
cp example/backend/.env.example example/backend/.env
```

The defaults assume a local macOS PostgreSQL where your shell `$USER` is a superuser with no password (typical for Homebrew Postgres). If that matches your setup, no edits are needed.

Similarly for frontend:

```bash
cp example/frontend/.env.example example/frontend/.env
```

**Note**: `.conductor/setup.ts` reads from `.env.example` and only overrides workspace-specific variables (ports, database names, Redis DBs). New environment variables added to `.env.example` will automatically flow through to Conductor workspaces.

## Common Commands

All commands from root unless noted. Backend tests require PostgreSQL (`keryx` and `keryx-test` databases) and Redis running locally.

```bash
bun install                        # Install all dependencies (all workspaces)
bun dev                            # Run both backend and frontend with hot reload
bun run ci                         # Full CI: lint + tests + docs tests across all workspaces
bun tests                          # Run tests for every workspace (package, plugins, examples)

# Per-workspace test scripts (from root)
bun test-package                   # packages/keryx
bun test-plugin-tracing            # packages/plugins/tracing
bun test-plugin-resque-admin       # packages/plugins/resque-admin
bun test-example-backend           # example/backend
bun test-example-frontend          # example/frontend

# Single test file (cd into the workspace first)
cd example/backend
bun test __tests__/actions/user.test.ts

# Example backend (run from example/backend/)
cd example/backend
bun run dev                        # Backend only with --watch
bun run start                      # Start server
bun run migrations                 # Generate DB migrations from schema changes

# Formatting (from root)
bun lint                           # Check formatting (biome) across all workspaces
bun format                         # Fix formatting (biome) across all workspaces
```

## Architecture

The `api` singleton (`packages/keryx/api.ts`) manages the full lifecycle: initialize -> start -> stop. Actions are the universal controller. For detailed architecture, read the relevant doc:

- Actions: `docs/guide/actions.md` — inputs, web routes, tasks, middleware, MCP config
- Initializers: `docs/guide/initializers.md` — priorities, module augmentation, lifecycle
- Channels: `docs/guide/channels.md` — PubSub, WebSocket, pattern matching
- MCP/OAuth: `docs/guide/mcp.md` — tool registration, OAuth 2.1, per-session servers
- Config: `docs/guide/config.md` — modular config, loadFromEnvIfSet(), env overrides
- Tasks/Fan-Out: `docs/guide/tasks.md` — background jobs, fanOut(), result collection
- Testing: `docs/guide/testing.md` — test structure, helpers, real HTTP requests
- CLI: `docs/guide/cli.md` — generators, start, upgrade
- Servers: `docs/reference/servers.md` — WebServer, routing, compression, static files
- Classes: `docs/reference/classes.md` — TypedError, Connection, ErrorType
- Utilities: `docs/reference/utilities.md` — Zod helpers, secret(), globLoader

## Imports

### In `packages/keryx/` (framework code)
Use relative imports:
```typescript
import { api } from "../api";
import { Action } from "../classes/Action";
```

### In `example/backend/` (app code)
Use `"keryx"` for framework imports, relative for app-local:
```typescript
import { api, Action, type ActionParams, HTTP_METHOD } from "keryx";
import { SessionMiddleware } from "../middleware/session";
```

## Coding Conventions

- **No `as any`** — Never use `as any` type assertions. Use `@ts-expect-error` with an explanatory comment when the type system can't express something, or add a proper type/interface.
- **Always `bunx`, never `npx`** — This is a Bun project. Use `bunx` for all package runner commands.
- **JSDoc annotations on public APIs** — All public classes, methods, and types in `packages/keryx/` must have JSDoc annotations. Use `@param` for every parameter (with detailed prose explaining edge cases), `@returns` when non-obvious, and `@throws {TypedError}` where applicable. See `Action.run()` in `packages/keryx/classes/Action.ts` as the reference pattern. Keep simpler methods concise — don't over-document the obvious.
- **Always use the plugin generator** — When creating a new plugin, always use `keryx generate plugin <name>` (or `keryx g plugin <name>`). This scaffolds the correct `KeryxPlugin` manifest in `plugins/` with the right structure and a matching test file. Never hand-write a plugin manifest from scratch.

## Testing

**Every code change should include tests.** When adding features, fixing bugs, or modifying behavior, always write or update tests to cover the change. If a PR has no test changes, that's a red flag.

Tests make real HTTP requests via `fetch` — no mock server. Tests run non-concurrently to avoid port conflicts. See `docs/guide/testing.md` for patterns, helpers (`serverUrl()`, `HOOK_TIMEOUT`), and test file structure.

## Documentation Site (`docs/`)

VitePress site at `keryxjs.com`. When modifying backend code, consider updating corresponding docs. Follow the editorial style guide at `docs/guide/style-guide.md`.

```bash
bun docs:dev                       # Preview docs locally
bun docs:build                     # Generate reference data + build static site
```

## Pull Requests

- **Never enable auto-merge** — Do not use `gh pr merge --auto` or enable auto-merge on PRs. PRs should always be merged manually after review.
- **Always bump the package version** — Every PR must bump `"version"` in `packages/keryx/package.json`. Use patch for bug fixes, minor for new features.
- **Link the issue when solving one** — If a PR resolves a GitHub issue, the PR body MUST contain `closes #<number>` (e.g. `closes #450`) so the issue auto-closes on merge. Referencing the issue number in the title alone is not enough.

## Gotcha: Stale Processes

If code changes aren't reflected in HTTP responses, check for stale `bun keryx` processes:
```bash
ps aux | grep "bun keryx" | grep -v grep
kill -9 <PIDs>
```
