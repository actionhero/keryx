# Maker comment

First comment under the launch listing. Posts the moment the launch goes live.

## Final

> Hey — I'm Evan, the maker.
>
> If you've shipped an MCP server in the last year, you've probably noticed you're writing your API twice. Your REST endpoints have Zod schemas, auth middleware, error handling, logging. Then you write a parallel MCP server that re-declares all of it with slightly different shapes, a different auth model, and its own way of returning errors. The two drift. Bugs only show up in one. It's the same duplication problem REST and WebSocket had a decade ago.
>
> Keryx is the framework I wanted for that. You write one **action** class, and it's automatically your HTTP endpoint, your WebSocket handler, your CLI command, your background task, and your MCP tool. Same Zod inputs, same middleware chain, same response shape. The only thing that changes is how the request arrives.
>
> ```ts
> export class UserCreate implements Action {
>   name = "user:create";
>   inputs = z.object({ name: z.string().min(3), email: z.string().email() });
>   web = { route: "/user", method: HTTP_METHOD.PUT };
>   task = { queue: "default" };
>   async run(params) { return { user: await createUser(params) }; }
> }
> ```
>
> That class is now a `PUT /api/user` endpoint, a WebSocket action, a CLI command with `--name` and `--email` flags generated from the schema, a Resque-backed background job, and an MCP tool that Claude Desktop discovers and calls with OAuth 2.1 — no extra wiring, no second server.
>
> The stack underneath: Bun for runtime (native TS, no build step, fast test runner), Zod for validation, Drizzle for the database with auto-migrations, Resque for jobs, and a Vite + React example frontend with end-to-end typed responses via `ActionResponse<MyAction>`. First-party plugins for OpenTelemetry tracing and a Resque admin UI ship in the same repo.
>
> Quick start:
>
> ```bash
> bunx keryx new my-app
> cd my-app && bun install && bun dev
> ```
>
> v0.30 — pre-1.0 but real. I'm running it in production, the docs at keryxjs.com are complete, and the example app is a working chat with channels, files, sessions, and the React frontend wired up. (For the Node.js old-timers: this is the spiritual successor to ActionHero, rewritten ground-up on Bun with MCP as a first-class transport.)
>
> Happy to answer anything in the comments — especially curious to hear from people who've hit the "writing MCP twice" wall.
>
> — Evan ([@evantahler](https://x.com/evantahler))

## Why this version

- Leads with the **duplicated-MCP-server pain**, not ActionHero history. New visitors care about today's problem.
- Code block early so the mechanic lands before anyone scrolls past.
- ActionHero is one parenthetical sentence near the end, framed as credentialing for Node old-timers rather than the lead.
- ~370 words — long but every paragraph is doing work. Don't trim unless the listing is getting low engagement.

## Quick stats

- Word count: ~370
- Code blocks: 2 (one for the action class, one for quickstart)
- Links: 1 (X handle at the end)
