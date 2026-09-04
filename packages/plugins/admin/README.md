# @keryxjs/admin

Browse, filter, and edit any table in your database — an admin dashboard plugin for [Keryx](https://keryxjs.com), in the spirit of RailsAdmin and Django's admin site.

Tables are discovered from `api.db.schema`, so a table added by a migration is browsable as soon as it exists. There is no scaffolding step and no screen to write per model.

Full documentation: [keryxjs.com/plugins/admin](https://keryxjs.com/plugins/admin)

## Install

```bash
bun add @keryxjs/admin
```

Requires `keryx` >= 0.43.0, which is the version that introduced `api.db.schema`.

## Register

The one required option is `resolveRole`, which decides who gets in. There's deliberately no default — how an application identifies an admin is a property of its schema, and a plugin that guessed would guess wrong.

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

The dashboard is then at `/api/admin`.

## Roles

Two roles, both resolved on every request so a revoked admin loses access immediately:

| Role | Can do |
| --- | --- |
| `read-only` | Browse, filter, sort, and read single records |
| `full` | Everything above, plus create, update, and delete |

Returning `null` denies access entirely (HTTP 401). A `read-only` caller attempting a write gets HTTP 403 — enforced server-side, not just hidden in the UI.

For anything a single row lookup can't answer — a join table, an external service — write the callback yourself:

```ts
adminPlugin({
  resolveRole: async (connection) => {
    const userId = connection.session?.data.userId;
    if (!userId) return null;
    return (await isPlatformAdmin(userId)) ? "full" : null;
  },
});
```

## Filtering

Filters are a tree. Leaves compare one column; branches combine them with `and`, `or`, and `not`, nested as deeply as you like.

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

Operators: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `like`, `ilike`, `contains`, `startsWith`, `endsWith`, `in`, `notIn`, `isNull`, `isNotNull`, `between`.

Column names resolve against real Drizzle columns before any SQL is built, and values bind as query parameters. The substring operators escape LIKE wildcards, so searching for `100%` finds that text rather than matching every row; `like` and `ilike` pass patterns through for when you want wildcards on purpose.

## The database validates writes

Unique indexes, foreign keys, NOT NULL, CHECK constraints, and type coercion already live in your schema, and that's the only place they can't drift out of sync with reality. So writes are attempted optimistically and PostgreSQL's `SQLSTATE` codes are translated into readable errors naming the constraint that rejected them:

```
create row in "users": a row with these values already exists
(constraint "users_email_idx"). Key (email)=(ada@example.com) already exists.
```

Add a constraint in a migration and the dashboard enforces it immediately, with no plugin change.

## Configuration

| Config | Env | Default | Purpose |
| --- | --- | --- | --- |
| `admin.enabled` | `ADMIN_ENABLED` | `true` | When false, every admin action responds 404 |
| `admin.serveUi` | `ADMIN_SERVE_UI` | `true` | When false, the built-in HTML dashboard is not served. JSON actions stay available |
| `admin.mcp` | `ADMIN_MCP_ENABLED` | `false` | Exposes all data actions as MCP tools, as one group |
| `admin.route` | `ADMIN_ROUTE` | `/admin` | Route prefix for the dashboard and its API |
| `admin.defaultLimit` | `ADMIN_DEFAULT_LIMIT` | `25` | Rows per page when unspecified |
| `admin.maxLimit` | `ADMIN_MAX_LIMIT` | `500` | Ceiling on rows per page |

Plus the registration options: `tables` (include/exclude lists), `columns` (per-table `hidden` and `readOnly`), `extraMiddleware` (appended to every data action, after the role gate), `writeMiddleware` (appended to create, update, and delete only), and `serveUi` (omit the built-in HTML when you ship your own UI).

### MCP

`ADMIN_MCP_ENABLED` is a single switch for the whole group — granting an agent generic read/write access to your database is one decision, not eight. It's off by default and also requires the MCP server itself (`MCP_SERVER_ENABLED`). The HTML UI action is never a tool.

## Actions

| Action | Route | Access |
| --- | --- | --- |
| `admin:ui` | `GET /admin` | none (returns no data) |
| `admin:tables` | `GET /admin/tables` | read |
| `admin:table:schema` | `GET /admin/tables/:table/schema` | read |
| `admin:table:list` | `POST /admin/tables/:table/list` | read |
| `admin:record:show` | `POST /admin/tables/:table/show` | read |
| `admin:record:create` | `PUT /admin/tables/:table/record` | write |
| `admin:record:update` | `POST /admin/tables/:table/record` | write |
| `admin:record:destroy` | `DELETE /admin/tables/:table/record` | write |

`list` and `show` are POST because a filter tree and a composite primary key are nested objects, and Keryx only merges JSON bodies for non-GET methods.

## The UI

One self-contained HTML file with inline CSS and JavaScript, served by `admin:ui`. No bundler, no build step, no `dist/`, and no CDN at runtime — the package ships raw TypeScript plus one `.html` file, so it behaves identically installed from npm or linked from a workspace. Every byte of data arrives through the same JSON actions an MCP client or `curl` would use.

The `/admin` route itself is unauthenticated because it returns no data; an anonymous visitor gets a "not authorized" prompt, not a database.

Set `serveUi: false` on `adminPlugin()` (or `ADMIN_SERVE_UI=false`) to skip that HTML action and keep the JSON APIs — the route is then free for a UI you build yourself.

If your app uses [`@keryxjs/csrf`](https://keryxjs.com/plugins/csrf), pass `CsrfMiddleware` via `writeMiddleware` to protect the writes. Not `extraMiddleware` — guarding reads would force the token into a GET query string, and reads change no state. The write actions declare an optional `csrfToken` input so the token survives Zod's unknown-key stripping, and the UI fetches and sends it automatically.

## Local development

```bash
bun dev:admin              # dashboard at http://localhost:8080/api/admin
ADMIN_DEV_ROLE=read-only bun dev:admin
```

This seeds a demo `customers`/`orders` schema and grants every visitor an admin role with no authentication. It's for looking at the UI, nothing else.

## License

MIT
