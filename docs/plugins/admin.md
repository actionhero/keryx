---
description: Admin dashboard plugin that browses, filters, and edits any table in your database, with read-only and full roles.
---

# Admin

`@keryxjs/admin` gives you a database admin dashboard in the spirit of RailsAdmin and Django's admin site: browse, filter, and edit any table in your application, without writing a screen per model.

Tables come from [`api.db.schema`](/guide/advanced-patterns#schema-introspection), the registry the framework builds from your `schema/` directory. A table added by a migration is browsable the moment it exists. There's no scaffolding step and nothing to regenerate.

Everything the dashboard does is an action, so the same surface is reachable from HTTP, `curl`, and — if you opt in — MCP.

## Installation

```bash
bun add @keryxjs/admin
```

Requires `keryx` 0.43.0 or newer, the version that introduced `api.db.schema`.

## Configuration

`adminPlugin` is a factory with one required option: `resolveRole`, which decides who gets in. There's no default, and that's deliberate — how your app identifies an admin is a property of your schema, and a plugin that guessed would guess wrong.

```ts
// config/plugins.ts
import { adminPlugin, roleFromUserColumn } from "@keryxjs/admin";
import type { KeryxPlugin } from "keryx";
import type { SessionImpl } from "../actions/session";
import { users } from "../schema/users";

export default {
  plugins: [
    adminPlugin({
      resolveRole: roleFromUserColumn<SessionImpl>({
        table: users,
        sessionKey: (session) => session.userId,
        role: (user) =>
          user.admin_role === "full" || user.admin_role === "read-only"
            ? user.admin_role
            : null,
      }),
      columns: {
        users: { hidden: ["password_hash"], readOnly: ["created_at"] },
      },
    }),
  ] as KeryxPlugin[],
};
```

The dashboard is now at `/api/admin`.

### Options

| Option | Purpose |
|--------|---------|
| `resolveRole` | **Required.** Returns `"full"`, `"read-only"`, or `null` to deny |
| `tables` | `{ include, exclude }` lists of SQL table names. Default: every table in `schema/` |
| `columns` | Per-table `{ hidden, readOnly }` column rules, keyed by SQL table name |
| `extraMiddleware` | Middleware appended to every data action, after the role gate |

### Config and environment

| Config | Env | Default | Purpose |
|--------|-----|---------|---------|
| `admin.enabled` | `ADMIN_ENABLED` | `true` | When false, every admin action responds 404 |
| `admin.mcp` | `ADMIN_MCP_ENABLED` | `false` | Exposes all data actions as MCP tools, as one group |
| `admin.route` | `ADMIN_ROUTE` | `/admin` | Route prefix for the dashboard and its API |
| `admin.defaultLimit` | `ADMIN_DEFAULT_LIMIT` | `25` | Rows per page when the caller doesn't ask |
| `admin.maxLimit` | `ADMIN_MAX_LIMIT` | `500` | Ceiling on rows per page |

## Roles

There are two, and both are resolved on every request — so revoking someone's access takes effect immediately rather than at their next login.

| Role | Can do |
|------|--------|
| `read-only` | Browse, filter, sort, and read single records |
| `full` | Everything above, plus create, update, and delete |

`null` denies access entirely (HTTP 401). A `read-only` caller attempting a write gets HTTP 403, enforced server-side — the UI hides the buttons as a courtesy, not as the control.

### Resolving the role yourself

`roleFromUserColumn` covers the common case: load the caller's user row, map a column to a role. When roles live somewhere a single row lookup can't reach — a join table, a permissions service — write the callback directly. It receives the live connection, so anything on the request is fair game:

```ts
adminPlugin({
  resolveRole: async (connection) => {
    const userId = connection.session?.data.userId;
    if (!userId) return null;

    const membership = await api.db.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.role, "owner")))
      .limit(1);

    return membership.length > 0 ? "full" : null;
  },
});
```

## Filtering

Filters are a tree. Leaves compare a single column; branches combine other filters with `and`, `or`, and `not`, nested as deeply as you need:

```ts
{
  and: [
    { column: "active", op: "eq", value: true },
    {
      or: [
        { column: "email", op: "endsWith", value: "@example.com" },
        { column: "tier", op: "in", value: ["pro", "enterprise"] },
      ],
    },
  ]
}
```

| Operators | Notes |
|-----------|-------|
| `eq`, `neq` | `value: null` becomes `IS NULL` / `IS NOT NULL` |
| `lt`, `lte`, `gt`, `gte` | |
| `contains`, `startsWith`, `endsWith` | Case-insensitive, and LIKE wildcards in the value are escaped |
| `like`, `ilike` | Pattern passed through, for when you want wildcards |
| `in`, `notIn` | Non-empty array |
| `between` | `[min, max]` array |
| `isNull`, `isNotNull` | No value |

Two properties worth knowing about. Column names are resolved against the table's real Drizzle columns before any SQL is built, so an unknown or hidden column fails loudly rather than reaching the database. And values bind as query parameters, never interpolated — which is also why `contains` escapes `%` and `_`: searching for `100%` finds that text instead of matching every row.

## The database validates writes

The dashboard does not re-implement your schema's rules in application code. Unique indexes, foreign keys, `NOT NULL`, `CHECK` constraints, and type coercion already live in the database, and that's the only place they can't drift out of sync with reality.

So writes are attempted optimistically, and PostgreSQL's `SQLSTATE` codes are translated into readable errors that name the constraint which rejected them:

```
create row in "users": a row with these values already exists
(constraint "users_email_idx"). Key (email)=(ada@example.com) already exists.
```

Add a constraint in a migration and the dashboard enforces it immediately, with no plugin change and no config to update.

::: tip
Hiding a column that is `NOT NULL` with no default makes the table un-insertable through the dashboard — there's no way to supply the required value. That's usually what you want for something like `password_hash`: browse and edit users here, create them through your signup action.
:::

## Actions

| Action | Route | Access |
|--------|-------|--------|
| `admin:ui` | `GET /admin` | none — returns no data |
| `admin:tables` | `GET /admin/tables` | read |
| `admin:table:schema` | `GET /admin/tables/:table/schema` | read |
| `admin:table:list` | `POST /admin/tables/:table/list` | read |
| `admin:record:show` | `POST /admin/tables/:table/show` | read |
| `admin:record:create` | `PUT /admin/tables/:table/record` | write |
| `admin:record:update` | `POST /admin/tables/:table/record` | write |
| `admin:record:destroy` | `DELETE /admin/tables/:table/record` | write |

`list` and `show` are POST because a filter tree and a composite primary key are nested objects, and Keryx only merges JSON bodies for non-GET methods. Query strings can't carry `{ or: [...] }` without inventing an encoding.

Records are addressed by a `pk` object keyed by primary key column, which is what makes composite keys work without a positional convention you'd have to guess:

```bash
curl -X POST http://localhost:8080/api/admin/tables/memberships/show \
  -H 'Content-Type: application/json' \
  -d '{"pk": {"user_id": 7, "team_id": 3}}'
```

A table with no primary key is reported as read-only. Without one there's no safe way to address a single row, and an admin tool that issues unbounded `UPDATE`s is a loaded gun.

## MCP

`ADMIN_MCP_ENABLED` exposes every admin data action as an MCP tool. It's a single switch for the whole group, because granting an agent generic read and write access to your database is one decision, not eight.

It's off by default, and also requires the MCP server itself:

```bash
MCP_SERVER_ENABLED=true
ADMIN_MCP_ENABLED=true
```

The HTML UI action is never registered as a tool. Everything else about [MCP](/guide/mcp) applies as usual — tool calls go through `connection.act()`, so the role gate and any `extraMiddleware` still run.

## The UI

One self-contained HTML file with inline CSS and JavaScript, served by `admin:ui`. No bundler, no build step, no `dist/` directory, and no CDN at runtime — the package ships raw TypeScript plus one `.html` file, so it behaves identically whether installed from npm or linked from a workspace.

The client is deliberately thin: it fetches table metadata from `admin:table:schema` and generates the grid and edit form from it, so it renders any schema without knowing anything about yours. Dark mode follows `prefers-color-scheme`.

The `/admin` route is unauthenticated because it returns no data. Every byte of content arrives through the JSON actions, which are gated. An anonymous visitor gets a "not authorized" prompt, not a database.

### Composing with CSRF

If your app uses [`@keryxjs/csrf`](/plugins/csrf), pass `CsrfMiddleware` through `extraMiddleware` to protect the write actions:

```ts
import { CsrfMiddleware } from "@keryxjs/csrf";

adminPlugin({
  resolveRole,
  extraMiddleware: [CsrfMiddleware],
});
```

Middleware runs after the role gate, so unauthorized callers are turned away before your middleware does any work on their behalf.

## Local development

To poke at the dashboard without wiring it into an app, the plugin ships a dev server that seeds a demo schema:

```bash
bun dev:admin                              # http://localhost:8080/api/admin
ADMIN_DEV_ROLE=read-only bun dev:admin     # see the role-gated UI
```

This grants every visitor an admin role with no authentication whatsoever. It's for looking at the UI, nothing else.

## Security notes

- **`resolveRole` is the whole perimeter.** It's required for a reason. Every data action calls it on every request.
- **Hide your secrets.** Columns holding password hashes, API keys, or tokens belong in `hidden`. Hidden columns are absent from listings, records, schema output, filters, and writes — a caller can't read them or tell them apart from columns that don't exist.
- **Narrow the surface.** `tables.include` is the tightest setting: an allowlist of exactly the tables the dashboard may touch. Anything not in your `schema/` directory is already invisible, which keeps migration bookkeeping tables out of reach.
- **Turn it off where it doesn't belong.** `ADMIN_ENABLED=false` makes every admin action respond 404, which is a better answer than 403 for an endpoint you'd rather nobody knew about.
- **Think twice before enabling MCP.** `ADMIN_MCP_ENABLED=true` hands an agent generic read and write access to every exposed table. Combine it with `tables.include` and `read-only` roles.
