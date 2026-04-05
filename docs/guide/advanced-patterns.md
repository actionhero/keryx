---
description: Production patterns for database transactions, RBAC, audit logging, and middleware composition in Keryx apps.
---

# Advanced Patterns

This guide shows how to compose Keryx primitives — [middleware](/guide/middleware), [actions](/guide/actions), and `connection.metadata` — into patterns you'll reach for in most production apps. The examples use a simple "team" domain, but the techniques apply to any multi-tenant or role-based application.

## Middleware Factories

The [middleware guide](/guide/middleware) shows static `ActionMiddleware` objects. But what if different actions need different permission levels? Instead of writing separate middleware for each role, write a function that takes a role and _returns_ a middleware:

```ts
function RequireRole(role: string): ActionMiddleware {
  return {
    runBefore: async (params, connection) => {
      // check the role, throw if insufficient
    },
  };
}
```

Now you can parameterize per-action: `middleware = [SessionMiddleware, RequireRole("admin")]`. The most common use of this pattern is role-based access control.

## Role-Based Access Control

### Roles and Hierarchy

Start by defining your roles and a way to compare them:

```ts
// roles.ts
export const Roles = ["viewer", "editor", "admin"] as const;
export type Role = (typeof Roles)[number];

const ROLE_LEVEL: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

/** Returns true if the user's role meets or exceeds the required role. */
export function meetsRole(userRole: Role, required: Role): boolean {
  return ROLE_LEVEL[userRole] >= ROLE_LEVEL[required];
}
```

### RBAC Middleware Factory

The middleware factory looks up the user's membership from the database, checks their role against the requirement, and stores the membership on `connection.metadata` for the action to use:

```ts
// rbac-middleware.ts
import {
  api,
  ErrorType,
  TypedError,
  type ActionMiddleware,
  type Connection,
} from "keryx";
import { eq, and } from "drizzle-orm";
import { meetsRole, type Role } from "./roles";
import { teamMembers } from "./schema";
import type { AppConnectionMeta } from "./types";

export function RbacMiddleware(requiredRole: Role): ActionMiddleware {
  return {
    runBefore: async (
      params: Record<string, unknown>,
      connection: Connection<any, AppConnectionMeta>,
    ) => {
      const userId = connection.session!.data.userId;
      const teamId = params.teamId as number;

      if (!teamId) {
        throw new TypedError({
          message: "teamId is required",
          type: ErrorType.ACTION_VALIDATION,
        });
      }

      try {
        const [membership] = await api.db.db
          .select()
          .from(teamMembers)
          .where(
            and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)),
          );

        if (!membership || !meetsRole(membership.role as Role, requiredRole)) {
          throw new TypedError({
            message: "Insufficient permissions",
            type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
          });
        }

        // Make the membership available to the action
        connection.metadata.membership = membership;
      } catch (e) {
        if (e instanceof TypedError) throw e;
        throw new TypedError({
          message: "An unexpected error occurred",
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
    },
  };
}
```

Use it on any action:

```ts
export class TeamEdit implements Action {
  name = "team:edit";
  middleware = [SessionMiddleware, RbacMiddleware("admin")];
  // ...

  async run(
    params: ActionParams<TeamEdit>,
    connection: Connection<any, AppConnectionMeta>,
  ) {
    const membership = connection.metadata.membership!; // set by RbacMiddleware
    // ...
  }
}
```

### Multiple Role Domains

Some apps have separate role hierarchies — for example, organization-level roles (owner, admin, member) and project-level roles (manager, editor, viewer) with no implicit access between them. In that case, create separate middleware factories for each domain:

```ts
middleware = [SessionMiddleware, OrgRbacMiddleware("admin")]; // control plane
middleware = [SessionMiddleware, ProjectRbacMiddleware("editor")]; // data plane
```

If an action should be accessible from _either_ domain (e.g. a project admin _or_ an org admin can manage project members), build a combined middleware that checks both and authorizes if either passes.

### Runtime Introspection

You can attach metadata to middleware objects for runtime inspection — useful for building permissions endpoints or auto-generating documentation. One approach is to use a well-known Symbol:

```ts
export const RBAC_DESCRIPTOR = Symbol.for("app.rbac");

export function RbacMiddleware(requiredRole: Role): ActionMiddleware {
  const mw: ActionMiddleware & { [RBAC_DESCRIPTOR]?: { role: Role } } = {
    runBefore: async (params, connection) => {
      /* ... */
    },
  };
  mw[RBAC_DESCRIPTOR] = { role: requiredRole };
  return mw;
}
```

An endpoint can then iterate over an action's `middleware` array, check for the Symbol, and expose the role requirements to the frontend or to AI agents.

## Database Transactions

Keryx provides two tools for wrapping database operations in transactions: `TransactionMiddleware` for action-scoped transactions and `withTransaction()` for standalone use.

### TransactionMiddleware

Add `TransactionMiddleware` to an action's middleware array. It opens a `BEGIN` in `runBefore`, stores the transaction-scoped Drizzle instance on `connection.metadata.transaction`, and commits or rolls back in `runAfter` based on whether the action succeeded:

```ts
import {
  Action,
  HTTP_METHOD,
  TransactionMiddleware,
  type ActionParams,
  type Connection,
  type Transaction,
} from "keryx";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "../schema";

export class TransferFunds extends Action {
  constructor() {
    super({
      name: "transfer:funds",
      middleware: [SessionMiddleware, TransactionMiddleware],
      web: { route: "/transfer", method: HTTP_METHOD.POST },
      inputs: z.object({
        fromId: z.number(),
        toId: z.number(),
        amount: z.number().positive(),
      }),
    });
  }

  async run(params: ActionParams<TransferFunds>, connection?: Connection) {
    const tx = connection!.metadata.transaction as Transaction;

    // Both updates happen atomically — if either fails, both roll back
    const [from] = await tx
      .update(accounts)
      .set({ balance: sql`balance - ${params.amount}` })
      .where(eq(accounts.id, params.fromId))
      .returning();
    const [to] = await tx
      .update(accounts)
      .set({ balance: sql`balance + ${params.amount}` })
      .where(eq(accounts.id, params.toId))
      .returning();

    return { from, to };
  }
}
```

If the action throws at any point, the transaction is rolled back automatically — no partial writes.

### withTransaction()

For one-off transactions outside the action lifecycle (ops functions, scripts, tests), use `withTransaction()`:

```ts
import { withTransaction } from "keryx";
import { users, auditLogs } from "../schema";

const user = await withTransaction(async (tx) => {
  const [created] = await tx
    .insert(users)
    .values({ name: "Alice", email: "alice@example.com", password_hash: hash })
    .returning();
  await tx.insert(auditLogs).values({ action: "user:create", userId: created.id });
  return created;
});
```

It acquires a dedicated connection from the pool, runs `BEGIN`, calls your callback, then `COMMIT` on success or `ROLLBACK` on error. `TypedError` is re-thrown directly; other errors are wrapped.

### Passing Transactions to Ops Functions

Use the `DbOrTransaction` type so helper functions accept either `api.db.db` (no transaction) or a `Transaction`:

```ts
import { api, type DbOrTransaction } from "keryx";
import { eq } from "drizzle-orm";
import { users } from "../schema";

export async function findUserByEmail(
  email: string,
  db: DbOrTransaction = api.db.db,
) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return user;
}
```

Now callers can use it with or without a transaction:

```ts
// Without transaction — uses api.db.db
const user = await findUserByEmail("alice@example.com");

// Inside TransactionMiddleware action
const user = await findUserByEmail(
  "alice@example.com",
  connection.metadata.transaction as Transaction,
);
```

### Chaining Actions in a Transaction

When an action calls a sub-action via `connection.act()`, the transaction propagates automatically. `TransactionMiddleware` is **re-entrant** — if a transaction already exists on `connection.metadata`, the child action reuses it instead of opening a new one. Only the outermost middleware commits or rolls back.

```ts
export class CreateUserWithWelcome extends Action {
  constructor() {
    super({
      name: "user:create-with-welcome",
      middleware: [TransactionMiddleware],
      web: { route: "/user/create-with-welcome", method: HTTP_METHOD.PUT },
      inputs: z.object({ name: z.string(), email: z.string() }),
    });
  }

  async run(params: ActionParams<CreateUserWithWelcome>, connection?: Connection) {
    const tx = connection!.metadata.transaction as Transaction;

    const [user] = await tx
      .insert(users)
      .values({ name: params.name, email: params.email, password_hash: hash })
      .returning();

    // Sub-action runs inside the same transaction — if it fails,
    // both the user creation and the welcome message roll back.
    const { error } = await connection!.act("message:create-welcome", {
      userId: user.id,
    });
    if (error) throw error;

    return { user };
  }
}
```

`connection.metadata` is preserved across nested `act()` calls (it resets only on the outermost call), so the child action sees the parent's `transaction`, `_txClient`, and any other metadata set by earlier middleware.

## Audit Logging with Base Action Classes

When many actions share the same cross-cutting concern — wrapping database writes in a transaction and inserting an audit log — you can extract that into an abstract base class. This pattern uses `TransactionMiddleware` to manage the transaction lifecycle and a `runAfter` hook to insert audit entries.

### The Base Class

```ts
// audited-action.ts
import {
  Action,
  TransactionMiddleware,
  type ActionMiddleware,
  type Connection,
  type Transaction,
} from "keryx";
import { z } from "zod";
import { auditLogs } from "./schema";
import type { AppConnectionMeta } from "./types";

/** Middleware that inserts an audit log entry inside the active transaction. */
const AuditLogMiddleware: ActionMiddleware = {
  runAfter: async (
    params: Record<string, unknown>,
    connection: Connection<any, AppConnectionMeta>,
    error,
  ) => {
    // Only audit successful operations
    if (error) return;

    const tx = connection.metadata.transaction as Transaction;
    if (!tx) return;

    await tx.insert(auditLogs).values({
      userId: connection.session?.data.userId ?? null,
      action: connection.metadata.auditAction ?? "unknown",
      metadata: params,
      before: connection.metadata.auditBefore ?? null,
      after: connection.metadata.auditAfter ?? null,
    });
  },
};

export abstract class AuditedAction extends Action {
  constructor(args: ConstructorParameters<typeof Action>[0]) {
    super({
      ...args,
      // TransactionMiddleware must come before AuditLogMiddleware so
      // the transaction is open when the audit insert runs
      middleware: [
        ...(args.middleware ?? []),
        TransactionMiddleware,
        AuditLogMiddleware,
      ],
    });
  }
}
```

The key detail: `AuditLogMiddleware.runAfter` runs _inside_ the same transaction that `TransactionMiddleware` manages. If the audit insert fails, the entire transaction rolls back.

### Using It

Subclasses set before/after snapshots on `connection.metadata` and use `connection.metadata.transaction` for all queries:

```ts
export class TeamEdit extends AuditedAction {
  constructor() {
    super({
      name: "team:edit",
      description: "Edit a team's settings",
      inputs: z.object({
        teamId: z.coerce.number(),
        name: z.string().min(1).optional(),
      }),
      middleware: [SessionMiddleware, RbacMiddleware("admin")],
      web: { route: "/team", method: HTTP_METHOD.PUT },
    });
  }

  async run(
    params: ActionParams<TeamEdit>,
    connection?: Connection<any, AppConnectionMeta>,
  ) {
    const tx = connection!.metadata.transaction as Transaction;
    connection!.metadata.auditAction = this.name;

    // Capture the before state
    const [before] = await tx
      .select()
      .from(teams)
      .where(eq(teams.id, params.teamId));
    connection!.metadata.auditBefore = before;

    // Make the change
    const [after] = await tx
      .update(teams)
      .set({ name: params.name })
      .where(eq(teams.id, params.teamId))
      .returning();
    connection!.metadata.auditAfter = after;

    return { team: after };
  }
}
```

The action only thinks about business logic. The base class composes `TransactionMiddleware` and `AuditLogMiddleware` to handle the transaction wrapper, audit logging, and error handling.

## Putting It Together

Here's the full request flow when these patterns are combined:

1. **SessionMiddleware** — verifies the user is authenticated
2. **RbacMiddleware("admin")** — looks up team membership, checks role, stores membership on `connection.metadata`
3. **TransactionMiddleware.runBefore** — opens a database transaction, stores it on `connection.metadata.transaction`
4. **Action.run()** — captures before state, makes the change, captures after state
5. **AuditLogMiddleware.runAfter** — inserts the audit entry in the same transaction
6. **TransactionMiddleware.runAfter** — commits the transaction (data change + audit log atomically)

If any step throws, everything after it is skipped — middleware short-circuits the action, and the transaction rolls back both the data change and the audit entry.
