---
description: CLI commands for scaffolding projects, generating components, running your Keryx server, and invoking actions from the terminal.
---

# CLI

Keryx includes a CLI (`keryx`) for common project tasks. When installed locally, run it with `bunx keryx`. When scaffolding a brand-new project, use `bunx keryx@latest`.

The CLI has two kinds of commands: **framework commands** that ship with Keryx, and **action commands** that are automatically generated from the [actions](/guide/actions) you write.

## Framework Commands

These are built-in commands for managing your project.

### `keryx new`

Scaffold a new Keryx project. See [Getting Started](/guide/) for the full walkthrough.

```bash
bunx keryx new my-app
```

Options:

- `-y` / `--yes` — skip prompts, use defaults
- `--no-interactive` — skip prompts, use defaults (same effect as `-y`)
- `--no-db` — skip database setup files
- `--no-example` — skip the example action
- `--force` — scaffold into an existing directory; files that already exist are left untouched (merge-skip, never overwrite)

`keryx new` also scaffolds OAuth template files into `templates/` (login/signup page, success page, shared CSS, and the lion SVG). These are customizable — see the [MCP guide](/guide/mcp#oauth-templates) for details.

### `keryx generate`

Generate a new component file with boilerplate. Aliased as `keryx g`.

```bash
bunx keryx generate <type> <name>
```

#### Supported Types

| Type          | Directory       | Example                         |
| ------------- | --------------- | ------------------------------- |
| `action`      | `actions/`      | `keryx g action user:delete`    |
| `initializer` | `initializers/` | `keryx g initializer cache`     |
| `middleware`  | `middleware/`   | `keryx g middleware auth`       |
| `channel`     | `channels/`     | `keryx g channel notifications` |
| `ops`         | `ops/`          | `keryx g ops UserOps`           |
| `plugin`      | `plugins/`      | `keryx g plugin analytics`      |

#### Naming Conventions

Colon-separated names create nested directories and map to routes for actions:

```bash
keryx g action user:delete
# Creates: actions/user/delete.ts
# Route:   /api/user/delete
# Class:   UserDelete
```

Simple names stay flat:

```bash
keryx g initializer cache
# Creates: initializers/cache.ts
# Class:   Cache
```

#### Options

- `--dry-run` — preview what would be generated without writing files
- `--force` — overwrite existing files
- `--no-test` — skip generating the companion test file

By default, each generated component also creates a matching test file in `__tests__/`.

#### Example Output

```bash
$ bunx keryx g action user:delete

Generated:
  actions/user/delete.ts
  __tests__/actions/user/delete.test.ts
```

The generated action file:

```ts
import { z } from "zod";
import { Action, type ActionParams, HTTP_METHOD } from "keryx";

export class UserDelete implements Action {
  name = "user:delete";
  description = "TODO: describe this action";
  inputs = z.object({});
  web = { route: "/user/delete", method: HTTP_METHOD.GET };

  async run(params: ActionParams<UserDelete>) {
    // TODO: implement
    return {};
  }
}
```

### `keryx upgrade`

Update framework-owned files (config, built-in actions, OAuth templates) to match the installed version of Keryx.

```bash
bunx keryx upgrade
```

Options:

- `--dry-run` — show what would change without writing
- `--force` — overwrite all framework files without confirmation
- `-y` / `--yes` — overwrite all framework files without confirmation (same effect as `--force`)

### `keryx build`

Pre-generate swagger response schemas so the server can skip the expensive and slow ts-morph analysis at startup. This is recommended for production deploys.

```bash
bunx keryx build
```

The command writes `.cache/swagger-schemas.json`. When the server starts and finds a valid cache, it skips ts-morph entirely.

**Recommended Dockerfile pattern:**

```dockerfile
COPY . .
RUN bun keryx.ts build
CMD ["bun", "keryx.ts", "start"]
```

If you skip this step, the server will attempt to generate schemas on the fly at startup. On machines with limited memory this may cause an out-of-memory crash. If ts-morph fails without crashing the process, the server will start with empty swagger response schemas.

### `keryx start`

Start the server.

```bash
bunx keryx start
```

### `keryx actions`

List all discovered actions with their routes and descriptions.

```bash
bunx keryx actions
```

## Action Commands

Every action you write is automatically registered as a CLI command — no extra configuration needed. Keryx discovers your actions and adds them to the CLI, so you can invoke any action directly from the terminal:

```bash
bunx keryx <action-name> [--input value]
```

When you run an action this way, Keryx starts the server in CLI mode (initializers run, but the web server doesn't bind a port), executes the action, prints the JSON result, and exits.

### Inputs as Flags

Action inputs map directly to CLI flags. Required inputs in your Zod schema become required CLI options; optional inputs become optional flags:

```bash
bunx keryx user:create --name evan --email "evan@example.com" --password secret
```

Run `--help` on any action to see its available parameters:

```bash
bunx keryx user:create --help
```

### Quiet Mode

By default, Keryx logs server startup output alongside the action response. Use `-q` / `--quiet` to suppress everything except the action's JSON result — handy for piping into `jq` or other tools:

```bash
bunx keryx status -q | jq
```

You can also set `CLI_QUIET=true` as an environment variable to make quiet mode the default.

### Error Output

When an action throws a `TypedError`, the CLI includes the error's `message`, `type`, `key`, and `value` in the JSON output. Stack traces are included by default; set `CLI_INCLUDE_STACK_IN_ERRORS=false` to omit them.
