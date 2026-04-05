---
description: Middleware intercepts action execution for authentication, authorization, logging, and response modification.
---

# Middleware

Middleware lets you run logic before and after an action executes — authentication checks, parameter normalization, response enrichment, logging, that sort of thing. If you've used Express middleware, the concept is similar, but scoped to individual actions rather than applied globally.

## The Basics

Here's the session middleware we use for authenticated endpoints. It's about as simple as middleware gets:

```ts
import { ErrorType, TypedError, type ActionMiddleware } from "keryx";

export const SessionMiddleware: ActionMiddleware = {
  runBefore: async (_params, connection) => {
    if (!connection.session || !connection.session.data.userId) {
      throw new TypedError({
        message: "Session not found",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }
  },
};
```

If `runBefore` throws, the action's `run()` method is skipped entirely and the error goes back to the client. That's the primary pattern for auth — check the session, throw if it's missing.

## Interface

```ts
type ActionMiddleware = {
  runBefore?: (
    params: ActionParams<Action>,
    connection: Connection,
  ) => Promise<ActionMiddlewareResponse | void>;
  runAfter?: (
    params: ActionParams<Action>,
    connection: Connection,
    error?: TypedError,
  ) => Promise<ActionMiddlewareResponse | void>;
};
```

Both methods are optional. You can have middleware that only runs before (auth), only runs after (logging), or both. `runAfter` always executes (even when the action throws) and receives the error as an optional third parameter — useful for cleanup like rolling back a transaction. Middleware can also modify params and responses by returning an `ActionMiddlewareResponse`:

```ts
type ActionMiddlewareResponse = {
  updatedParams?: ActionParams<Action>;
  updatedResponse?: any;
};
```

## Applying Middleware

Add middleware to an action via the `middleware` array:

```ts
export class UserEdit implements Action {
  name = "user:edit";
  middleware = [SessionMiddleware];
  // ...
}
```

Middleware runs in array order. If you have `[AuthMiddleware, RateLimitMiddleware]`, auth runs first — if it throws, rate limiting never executes.

## Common Patterns

### Authentication

This is the most common use case. Check that a session exists and has the data you expect:

```ts
export const SessionMiddleware: ActionMiddleware = {
  runBefore: async (_params, connection) => {
    if (!connection.session?.data.userId) {
      throw new TypedError({
        message: "Session not found",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }
  },
};
```

### Param Normalization

You can modify params before the action sees them — useful for things like lowercasing emails:

```ts
export const NormalizeMiddleware: ActionMiddleware = {
  runBefore: async (params) => {
    return {
      updatedParams: {
        ...params,
        email: params.email?.toLowerCase(),
      },
    };
  },
};
```

That said, you can also handle this in the Zod schema with `.transform()` — so use whichever approach makes more sense for your case.

### Rate Limiting

The built-in `RateLimitMiddleware` uses a Redis-backed sliding window to limit request rates per client. It identifies users by user ID (authenticated) or IP address (unauthenticated):

```ts
import { RateLimitMiddleware } from "keryx";

export class ApiEndpoint implements Action {
  name = "api:endpoint";
  middleware = [SessionMiddleware, RateLimitMiddleware];
  // ...
}
```

When a client exceeds the limit, the middleware throws a `CONNECTION_RATE_LIMITED` error (HTTP 429). Rate limit info is attached to the connection and included in response headers automatically.

See the [Security guide](/guide/security) for configuration options and custom limit overrides.

### Database Transactions

The built-in `TransactionMiddleware` wraps the entire action lifecycle in a database transaction. It opens a transaction in `runBefore`, stores it on `connection.metadata.transaction`, and commits or rolls back in `runAfter` based on whether the action succeeded:

```ts
import { TransactionMiddleware, type Transaction } from "keryx";

export class TransferFunds extends Action {
  constructor() {
    super({
      name: "transfer:funds",
      middleware: [SessionMiddleware, TransactionMiddleware],
      web: { route: "/transfer", method: HTTP_METHOD.POST },
      inputs: z.object({ fromId: z.number(), toId: z.number(), amount: z.number() }),
    });
  }

  async run(params: ActionParams<TransferFunds>, connection?: Connection) {
    const tx = connection!.metadata.transaction as Transaction;
    // Both updates happen atomically — if either fails, both roll back
    await tx.update(accounts).set({ ... }).where(eq(accounts.id, params.fromId));
    await tx.update(accounts).set({ ... }).where(eq(accounts.id, params.toId));
    return { success: true };
  }
}
```

For one-off transactions outside the middleware lifecycle, use the `withTransaction()` utility. See the [Advanced Patterns guide](/guide/advanced-patterns) for more details.

### Passing Data Between Middleware and Actions

Use `connection.metadata` to pass request-scoped data from middleware to actions (or between `runBefore` and `runAfter`). Metadata is reset to `{}` at the start of each `act()` call, so long-lived connections like WebSockets won't leak state between requests.

First, declare your metadata shape:

```ts
// types.ts
import type { Membership, Project } from "./models";

export type AppConnectionMeta = {
  membership?: Membership;
  project?: Project;
  auditBefore?: Record<string, unknown>;
  auditAfter?: Record<string, unknown>;
};
```

Then use it in middleware and actions with the second generic on `Connection`:

```ts
import type { Connection } from "keryx";
import type { AppConnectionMeta } from "../types";

export const RbacMiddleware: ActionMiddleware = {
  runBefore: async (
    _params,
    connection: Connection<any, AppConnectionMeta>,
  ) => {
    const membership = await resolveMembership(connection.session!.data.userId);
    connection.metadata.membership = membership; // type-safe write
  },
};
```

```ts
export class OrgView extends Action {
  middleware = [SessionMiddleware, RbacMiddleware];

  async run(
    params: ActionParams<OrgView>,
    connection: Connection<any, AppConnectionMeta>,
  ) {
    const membership = connection.metadata.membership; // type-safe read
    // ...
  }
}
```

This replaces the old pattern of casting through `unknown` to attach properties to the connection.

### Response Enrichment

`runAfter` can add data to the response. This runs after the action's `run()` method completes:

```ts
export const TimingMiddleware: ActionMiddleware = {
  runBefore: async (_params, connection) => {
    connection.metadata._startTime = Date.now();
  },
  runAfter: async (_params, connection) => {
    return {
      updatedResponse: {
        requestDuration: Date.now() - (connection.metadata._startTime as number),
      },
    };
  },
};
```
