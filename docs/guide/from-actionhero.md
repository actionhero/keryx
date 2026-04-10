---
description: Migration guide from ActionHero — unified action/task controllers, route-on-action, Drizzle ORM replacing Sequelize, MCP as a transport, and removed features.
---

# Coming from ActionHero

Keryx is the spiritual successor to [ActionHero](https://www.actionherojs.com). It keeps the core ideas — transport-agnostic controllers, built-in background tasks, real-time channels — but rewrites everything on Bun with first-class MCP support, Zod validation, and Drizzle ORM. If you've used ActionHero before, here's what changed and why.

## Unified Controllers

The biggest structural change: actions, tasks, and CLI commands are the same thing. In ActionHero you had separate `Action` and `Task` classes. In Keryx, there's just `Action`. Add a `task` property to make it a background job, add a `web` property for HTTP, or do both. Same `run()` method, same inputs, same middleware. See the [Actions guide](/guide/actions) for details.

## Separate Applications

The frontend and backend are separate Bun applications. No `ah-next-plugin` — the Vite + React app is its own project in `frontend/`. Deploy them independently: frontend on Vercel, backend on a VPS, whatever works. They share types but not a process.

## Routes on Actions

Actions define their own routes — strings with `:params` or RegExp patterns — directly on the action class. No `routes.ts` file. This keeps routing close to the handler and eliminates a common source of drift.

```ts
web = { route: "/user/:id", method: HTTP_METHOD.GET };
```

## MCP as a Transport

Every action is automatically available as an [MCP tool](/guide/mcp) for AI agents. OAuth 2.1 with PKCE handles authentication. This didn't exist in ActionHero.

## Real-Time Channels

PubSub via Redis with middleware-based authorization for WebSocket clients. Channels support pattern matching (RegExp names) and [presence tracking](/guide/channels#presence-tracking). See [Channels](/guide/channels).

## Drizzle ORM

First-class database support with [Drizzle ORM](https://orm.drizzle.team), auto-migrations, and type-safe schemas. Replaces the old `ah-sequelize-plugin`.

## Environment Config

Config is static at boot, loaded from TypeScript files with per-`NODE_ENV` overrides via environment variables. The `loadFromEnvIfSet()` helper checks `${ENV_VAR}_${NODE_ENV}` first, then `${ENV_VAR}`, then falls back to the default. See [Configuration](/guide/config).

## Simplified Logger

No Winston. STDOUT and STDERR only, with optional colors and timestamps. The `Logger` class supports levels from `trace` to `fatal`.

## Middleware

Applied to actions as an array of `ActionMiddleware` objects with `runBefore` and `runAfter` hooks. Can throw to halt execution, or modify params/responses. See [Middleware](/guide/middleware).

## Testing

No mock server. Tests make real HTTP requests with `fetch` — Bun includes it natively. Each test file boots the full server on a random port. See [Testing](/guide/testing).

## Sessions

Cookie-based sessions stored in Redis are a first-class part of the framework. `SessionMiddleware` handles authentication. See [Authentication](/guide/authentication).

## Removed Features

- **No Pidfiles** — Process management is left to your deployment tooling (systemd, Docker, etc.)
- **No Cache Layer** — The old ActionHero cache has been removed. Use Redis directly — it's already part of the stack.
- **No `ah-*-plugin` pattern** — Functionality that was previously in plugins (Sequelize, Next.js) is built in or handled as a separate application (the example frontend is now Vite + React).
