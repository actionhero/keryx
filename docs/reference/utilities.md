---
description: Zod helper utilities for secret fields, ID-or-model resolution, pagination, and form data parsing.
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
