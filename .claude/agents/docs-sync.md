# Docs Sync

Check whether documentation needs updating after backend or framework code changes.

## Instructions

### 1. Identify what changed

Run `git diff main --name-only` (or `git diff HEAD~1 --name-only` if already on main) to get the list of changed files. Focus on:
- `packages/keryx/` — framework code
- `example/backend/` — example app code

Ignore changes to test files, `.env` files, and the `docs/` directory itself.

### 2. Map code changes to docs

Use this mapping to identify which docs might need updates:

| Code Area | Relevant Docs |
|-----------|---------------|
| `classes/Action.ts`, action files | `docs/guide/actions.md`, `docs/reference/actions.md` |
| `classes/API.ts`, `api.ts` | `docs/reference/classes.md` |
| Initializer files | `docs/guide/initializers.md`, `docs/reference/initializers.md` |
| `classes/Channel.ts`, channel files | `docs/guide/channels.md` |
| MCP/OAuth code | `docs/guide/mcp.md` |
| Config files | `docs/guide/config.md`, `docs/reference/config.md` |
| Server/web files | `docs/reference/servers.md` |
| Middleware files | `docs/guide/middleware.md` |
| Task/fan-out code | `docs/guide/tasks.md` |
| Zod helpers, utilities | `docs/reference/utilities.md` |
| CLI/generators | `docs/guide/cli.md` |
| TypedError, Connection, Logger | `docs/reference/classes.md` |
| Auth-related code | `docs/guide/authentication.md` |
| Observability code | `docs/guide/observability.md` |

### 3. Check for staleness

For each relevant doc:
1. Read the doc file
2. Read the changed source code
3. Compare: does the doc accurately reflect the current code?

Look for:
- **Changed signatures** — method parameters, return types, or names that differ from what the doc shows
- **New features** — exported classes, methods, config options, or action properties not mentioned in docs
- **Removed features** — things documented that no longer exist in code
- **Changed defaults** — config defaults, timeout values, etc. that have been updated
- **Incorrect examples** — code snippets in docs that would no longer work

### 4. Report findings

Provide a concise summary:

- **Up to date**: list docs that were checked and are fine (one line each)
- **Needs update**: for each stale doc, explain specifically what's wrong and what the correct content should be

Do NOT edit docs files yourself — just report what needs changing so the user can review and decide.
