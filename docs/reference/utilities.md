---
description: Zod helper utilities — secret() field redaction, zBooleanFromString(), paginationInputs(), paginate() for Drizzle queries, and the zIdOrModel() factory for ID-or-object resolution.
---

# Utilities

Keryx provides several Zod helper utilities in `packages/keryx/util/zodMixins.ts` for common patterns. App-specific helpers like `zUserIdOrModel()` and `zMessageIdOrModel()` live in `example/backend/util/zodMixins.ts`.

## `secret(schema)`

Marks a Zod schema as secret so the field is redacted as `[[secret]]` in request logs. Uses Zod v4's native `.meta()` API.

```ts
import { secret } from "keryx";

inputs = z.object({
  email: z.string().email(),
  password: secret(z.string().min(8)),
});
```

When a request comes in with `password: "hunter2"`, the logs will show `password: [[secret]]`.

## `isSecret(schema)`

Check if a Zod schema has been marked as secret:

```ts
import { isSecret } from "keryx";

if (isSecret(schema)) {
  // redact this field in output
}
```

## `zBooleanFromString()`

Creates a Zod schema that accepts both boolean and string values, transforming `"true"` and `"false"` strings into actual booleans. Useful for HTML form data where booleans arrive as strings.

```ts
import { zBooleanFromString } from "keryx";

inputs = z.object({
  active: zBooleanFromString(),
});

// Accepts: true, false, "true", "false"
// Returns: boolean
```

## `paginationInputs()`

Creates a Zod schema for pagination inputs with sensible defaults. Returns `{ page, limit }` where `page` is 1-indexed. Accepts an optional configuration object for custom defaults and bounds.

```ts
import { paginationInputs } from "keryx";

// Use defaults: page=1, limit=25, maxLimit=100
inputs = paginationInputs();

// Custom defaults
inputs = paginationInputs({ defaultLimit: 10, maxLimit: 50 });
```

Both `page` and `limit` use `z.coerce.number()` so they work with query string parameters out of the box.

| Option | Default | Description |
|--------|---------|-------------|
| `defaultLimit` | `25` | Default items per page when `limit` is not provided |
| `maxLimit` | `100` | Maximum allowed value for `limit` |

## `paginate()`

Applies pagination to a Drizzle select query and returns a standardized envelope. Runs the data query and a count query in parallel via `Promise.all`.

```ts
import { paginate, type PaginatedResult } from "keryx";
```

```ts
function paginate<T>(
  query,      // Drizzle select query (before .limit()/.offset())
  countQuery, // Promise resolving to [{ count: number }]
  params,     // { page, limit } from paginationInputs()
): Promise<PaginatedResult<T>>
```

The response envelope:

```ts
interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;   // Current page (1-indexed)
    limit: number;  // Items per page
    total: number;  // Total matching records
    pages: number;  // Total pages (ceil(total / limit))
  };
}
```

### Full example

```ts
import {
  type Action,
  type ActionParams,
  api,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { count, desc, eq } from "drizzle-orm";
import { messages } from "../schema/messages";
import { users } from "../schema/users";

export class MessagesList implements Action {
  name = "messages:list";
  description = "List messages with pagination.";
  web = { route: "/messages/list", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 10 });

  async run(params: ActionParams<MessagesList>) {
    const result = await paginate(
      api.db.db
        .select({ id: messages.id, body: messages.body, user_name: users.name })
        .from(messages)
        .orderBy(desc(messages.id))
        .leftJoin(users, eq(users.id, messages.user_id)),
      api.db.db.select({ count: count() }).from(messages),
      params,
    );

    return { messages: result.data, pagination: result.pagination };
  }
}
```

`GET /api/messages/list?page=2&limit=5` returns:

```json
{
  "messages": [ ... ],
  "pagination": { "page": 2, "limit": 5, "total": 23, "pages": 5 }
}
```

The count query is a separate argument so you have full control — use different JOINs, add WHERE clauses, or skip joins that don't affect the total count.

## `zIdOrModel()` Factory

A generic factory that creates a Zod schema accepting either a numeric ID or a full model object. If an ID is provided, it resolves to the full model via a database lookup using an async Zod transform.

```ts
function zIdOrModel<TTable extends TableWithId, TModel>(
  table: TTable, // Drizzle table definition (must have `id` column)
  modelSchema: z.ZodType<TModel>, // Zod schema for the model
  isModel: (val: unknown) => val is TModel, // Type guard function
  entityName: string, // For error messages
);
```

Throws a `TypedError` if the ID doesn't match any record.

### `zUserIdOrModel()`

Pre-built helper for the users table:

```ts
import { zUserIdOrModel } from "../util/zodMixins";

inputs = z.object({
  user: zUserIdOrModel(),
});

// Accepts: 1, 42, or a full User object
// Returns: User (resolved from DB if ID was provided)
```

### `zMessageIdOrModel()`

Pre-built helper for the messages table:

```ts
import { zMessageIdOrModel } from "../util/zodMixins";

inputs = z.object({
  message: zMessageIdOrModel(),
});

// Accepts: 1, 42, or a full Message object
// Returns: Message (resolved from DB if ID was provided)
```

### Creating Your Own

To create a resolver for a custom table, use the `zIdOrModel` factory directly:

```ts
import { zIdOrModel } from "keryx";
import { createSchemaFactory } from "drizzle-zod";
import { z } from "zod";
import { projects, type Project } from "../schema/projects";

const { createSelectSchema } = createSchemaFactory({ zodInstance: z });
const zProjectSchema = createSelectSchema(projects);

function isProject(val: unknown): val is Project {
  return zProjectSchema.safeParse(val).success;
}

export function zProjectIdOrModel() {
  return zIdOrModel(
    projects,
    zProjectSchema as z.ZodType<Project>,
    isProject,
    "Project",
  );
}
```

## Auto-Generated Drizzle Schemas

The Zod schemas for database models are auto-generated from Drizzle table definitions using `drizzle-zod`:

```ts
import { createSchemaFactory } from "drizzle-zod";
const { createSelectSchema } = createSchemaFactory({ zodInstance: z });

export const zUserSchema = createSelectSchema(users);
export const zMessageSchema = createSelectSchema(messages);
```

These stay in sync with the database schema automatically — when you add a column to the Drizzle table, the Zod schema updates too.

## Loading & Comparison Helpers

### `globLoader(searchDir)`

Recursively loads every `.ts` file under `searchDir`, instantiates each exported class, and returns the instances. This is what discovers your actions, initializers, channels, and middleware — it's the mechanism behind "drop a file in the directory and it works."

```ts
import { globLoader } from "keryx";
import { Action } from "keryx";

const actions = await globLoader<Action>("./actions");
```

Throws a `TypedError` with `ErrorType.SERVER_INITIALIZATION` if any class fails to instantiate.

### `safeCompare(a, b)`

Constant-time string comparison. Both values are SHA-256 hashed before `timingSafeEqual`, so unequal lengths can't leak through a length oracle. Use it anywhere you compare a secret supplied by a caller — API keys, tokens, admin passwords:

```ts
import { safeCompare } from "keryx";

if (!safeCompare(params.apiKey, config.myPlugin.apiKey)) {
  throw new TypedError({
    message: "invalid key",
    type: ErrorType.CONNECTION_ACTION_RUN,
  });
}
```

A plain `===` on a secret is a timing side-channel. Reach for this instead.

## CLI & Generator Helpers

These back the `keryx` CLI. You need them only when building your own CLI entry point or a [plugin generator](/guide/plugins).

| Export             | Signature                        | Purpose                                                              |
| ------------------ | -------------------------------- | -------------------------------------------------------------------- |
| `buildProgram()`   | `(opts) => Promise<Command>`     | Builds the Commander program with every framework and action command  |
| `getValidTypes()`  | `() => string[]`                 | All valid `keryx generate` type names, including plugin-registered ones |
| `PluginGenerator`  | type                             | Shape a plugin implements to add its own `keryx generate <type>`      |

## Swagger Schema Cache

The web server pre-generates OpenAPI schemas so the first request doesn't pay for it. `keryx build` calls these; you'd only call them directly when building a custom deploy pipeline.

| Export                     | Purpose                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `generateSwaggerSchemas()` | Build OpenAPI schemas for every registered action                |
| `computeActionsHash()`     | Fingerprint the current action set, used to invalidate the cache |
| `writeSchemasCache()`      | Persist generated schemas to disk                                |
| `loadCachedSchemas()`      | Read schemas back, returning `undefined` on a hash mismatch      |
| `JSONSchema`               | Type of a generated schema object                                |

## Constants & Enums

| Export                 | Type                          | Value / Purpose                                                        |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `CHANNEL_NAME_PATTERN` | `RegExp`                      | `/^[a-zA-Z0-9:._-]{1,200}$/` — validates [channel](/guide/channels) names |
| `MCP_APP_MIME_TYPE`    | `string`                      | `text/html;profile=mcp-app`, the MIME type for [MCP App](/guide/mcp-apps) resources |
| `MCP_RESPONSE_FORMAT`  | enum                          | `JSON` or `MARKDOWN` — an action's [MCP response format](/guide/mcp#response-format) |
| `HTTP_METHOD`          | enum                          | HTTP verbs for an action's `web.method`                                |
| `LogFormat`            | enum                          | `text` or `json` — see [Logger](/reference/classes#logger)             |
| `LogLevel`             | enum                          | Logger verbosity threshold                                             |
| `ExitCode`             | enum                          | `success = 0`, `error = 1` — used by the CLI runner and signal handlers |
| `ErrorStatusCodes`     | `Record<ErrorType, number>`   | Maps each `ErrorType` to its HTTP status — see [TypedError](/reference/classes#typederror) |
| `CONNECTION_TYPE`      | enum                          | Transport that opened a [Connection](/reference/classes#connection)    |

## Testing Helpers

Exported from the `keryx/testing` subpath, not the package root:

```ts
import { useTestServer, serverUrl, waitFor, HOOK_TIMEOUT } from "keryx/testing";
```

| Export             | Signature                                              | Purpose                                                        |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------- |
| `useTestServer()`  | `(opts?) => void`                                       | Registers `beforeAll`/`afterAll` to boot and stop the server    |
| `serverUrl()`      | `() => string`                                          | The URL the server actually bound to, with the resolved port    |
| `waitFor()`        | `(condition, { interval, timeout }) => Promise<void>`   | Polls until `condition` returns `true`, instead of a fixed sleep |
| `HOOK_TIMEOUT`     | `60_000`                                                | Timeout to pass to your own `beforeAll`/`afterAll` hooks        |

See the [Testing guide](/guide/testing) for how these fit together.
