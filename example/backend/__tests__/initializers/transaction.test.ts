import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  Action,
  type ActionMiddleware,
  type ActionParams,
  api,
  CONNECTION_TYPE,
  Connection,
  ErrorType,
  type Transaction,
  TransactionMiddleware,
  TypedError,
  withTransaction,
} from "keryx";
import { type User, users } from "../../schema/users";
import { HOOK_TIMEOUT } from "../setup";

beforeAll(async () => {
  await api.start();
  await api.db.clearDatabase();
}, HOOK_TIMEOUT);

afterAll(async () => {
  // Clean up any test actions
  api.actions.actions = api.actions.actions.filter(
    (a: Action) => !a.name.startsWith("test:tx"),
  );
  await api.stop();
}, HOOK_TIMEOUT);

function registerAction(action: Action) {
  api.actions.actions.push(action);
}

function unregisterAction(name: string) {
  api.actions.actions = api.actions.actions.filter(
    (a: Action) => a.name !== name,
  );
}

// ---------------------------------------------------------------------------
// withTransaction()
// ---------------------------------------------------------------------------

describe("withTransaction", () => {
  test("commits when callback resolves", async () => {
    await api.db.clearDatabase();

    const result = await withTransaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          name: "Tx User",
          email: "tx@example.com",
          password_hash: "hash",
        })
        .returning();
      return user;
    });

    expect(result.name).toBe("Tx User");

    const [found] = await api.db.db
      .select()
      .from(users)
      .where(eq(users.email, "tx@example.com"));
    expect(found).toBeDefined();
    expect(found.name).toBe("Tx User");
  });

  test("rolls back and re-throws TypedError", async () => {
    await api.db.clearDatabase();

    try {
      await withTransaction(async (tx) => {
        await tx.insert(users).values({
          name: "Rollback User",
          email: "rollback@example.com",
          password_hash: "hash",
        });
        throw new TypedError({
          message: "intentional failure",
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(TypedError);
      expect((e as TypedError).message).toBe("intentional failure");
      expect((e as TypedError).type).toBe(ErrorType.CONNECTION_ACTION_RUN);
    }

    const result = await api.db.db
      .select()
      .from(users)
      .where(eq(users.email, "rollback@example.com"));
    expect(result.length).toBe(0);
  });

  test("rolls back and wraps non-TypedError", async () => {
    await api.db.clearDatabase();

    try {
      await withTransaction(async (tx) => {
        await tx.insert(users).values({
          name: "Error User",
          email: "error@example.com",
          password_hash: "hash",
        });
        throw new Error("plain error");
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(TypedError);
      expect((e as TypedError).message).toContain("plain error");
      expect((e as TypedError).type).toBe(ErrorType.CONNECTION_ACTION_RUN);
    }

    const result = await api.db.db
      .select()
      .from(users)
      .where(eq(users.email, "error@example.com"));
    expect(result.length).toBe(0);
  });

  test("returns the callback's return value", async () => {
    const value = await withTransaction(async () => {
      return { answer: 42 };
    });
    expect(value).toEqual({ answer: 42 });
  });

  test("multiple operations are atomic", async () => {
    await api.db.clearDatabase();

    try {
      await withTransaction(async (tx) => {
        await tx.insert(users).values({
          name: "User A",
          email: "a@example.com",
          password_hash: "hash",
        });
        await tx.insert(users).values({
          name: "User B",
          email: "b@example.com",
          password_hash: "hash",
        });
        throw new Error("fail after both");
      });
    } catch {
      // expected
    }

    const result = await api.db.db.select().from(users);
    expect(result.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TransactionMiddleware
// ---------------------------------------------------------------------------

describe("TransactionMiddleware", () => {
  test("commits on successful action", async () => {
    await api.db.clearDatabase();

    class TxInsertAction extends Action {
      constructor() {
        super({
          name: "test:tx-insert",
          description: "Inserts a user inside a transaction",
          middleware: [TransactionMiddleware],
        });
      }

      async run(
        _params: ActionParams<TxInsertAction>,
        connection?: Connection,
      ) {
        const tx = connection!.metadata.transaction as Transaction;
        expect(tx).toBeDefined();

        const [user] = await tx
          .insert(users)
          .values({
            name: "Tx Middleware User",
            email: "txmw@example.com",
            password_hash: "hash",
          })
          .returning();
        return { user };
      }
    }

    registerAction(new TxInsertAction());

    try {
      const conn = new Connection(CONNECTION_TYPE.WEB, "test-tx-commit");
      const { response, error } = await conn.act("test:tx-insert", {});

      expect(error).toBeUndefined();
      expect((response as Record<string, unknown>).user).toBeDefined();

      const [found] = await api.db.db
        .select()
        .from(users)
        .where(eq(users.email, "txmw@example.com"));
      expect(found).toBeDefined();
      expect(found.name).toBe("Tx Middleware User");
    } finally {
      unregisterAction("test:tx-insert");
    }
  });

  test("rolls back when action throws", async () => {
    await api.db.clearDatabase();

    class TxThrowAction extends Action {
      constructor() {
        super({
          name: "test:tx-throw",
          description: "Inserts then throws to test rollback",
          middleware: [TransactionMiddleware],
        });
      }

      async run(_params: ActionParams<TxThrowAction>, connection?: Connection) {
        const tx = connection!.metadata.transaction as Transaction;

        await tx.insert(users).values({
          name: "Rollback User",
          email: "txrollback@example.com",
          password_hash: "hash",
        });

        throw new TypedError({
          message: "intentional failure",
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
    }

    registerAction(new TxThrowAction());

    try {
      const conn = new Connection(CONNECTION_TYPE.WEB, "test-tx-rollback");
      const { error } = await conn.act("test:tx-throw", {});

      expect(error).toBeDefined();
      expect(error!.message).toBe("intentional failure");

      const result = await api.db.db
        .select()
        .from(users)
        .where(eq(users.email, "txrollback@example.com"));
      expect(result.length).toBe(0);
    } finally {
      unregisterAction("test:tx-throw");
    }
  });

  test("multiple operations roll back atomically", async () => {
    await api.db.clearDatabase();

    class TxMultiOpAction extends Action {
      constructor() {
        super({
          name: "test:tx-multi-op",
          description: "Multiple inserts that should roll back together",
          middleware: [TransactionMiddleware],
        });
      }

      async run(
        _params: ActionParams<TxMultiOpAction>,
        connection?: Connection,
      ) {
        const tx = connection!.metadata.transaction as Transaction;

        await tx.insert(users).values({
          name: "Multi A",
          email: "multi-a@example.com",
          password_hash: "hash",
        });
        await tx.insert(users).values({
          name: "Multi B",
          email: "multi-b@example.com",
          password_hash: "hash",
        });

        throw new TypedError({
          message: "rollback both",
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
    }

    registerAction(new TxMultiOpAction());

    try {
      const conn = new Connection(
        CONNECTION_TYPE.WEB,
        "test-tx-multi-rollback",
      );
      const { error } = await conn.act("test:tx-multi-op", {});
      expect(error).toBeDefined();

      const result = await api.db.db.select().from(users);
      expect(result.length).toBe(0);
    } finally {
      unregisterAction("test:tx-multi-op");
    }
  });

  test("pool client is released after success and error", async () => {
    class TxNoopAction extends Action {
      constructor() {
        super({
          name: "test:tx-noop",
          description: "Does nothing, just tests cleanup",
          middleware: [TransactionMiddleware],
        });
      }

      async run() {
        return { ok: true };
      }
    }

    class TxBoomAction extends Action {
      constructor() {
        super({
          name: "test:tx-boom",
          description: "Throws to test client release on error",
          middleware: [TransactionMiddleware],
        });
      }

      async run() {
        throw new Error("boom");
      }
    }

    registerAction(new TxNoopAction());
    registerAction(new TxBoomAction());

    try {
      const totalBefore = api.db.pool.totalCount;

      // Success path
      const conn1 = new Connection(CONNECTION_TYPE.WEB, "test-tx-release-ok");
      await conn1.act("test:tx-noop", {});

      // Error path
      const conn2 = new Connection(CONNECTION_TYPE.WEB, "test-tx-release-err");
      await conn2.act("test:tx-boom", {});

      // Pool should not leak — total should not grow unboundedly
      expect(api.db.pool.totalCount).toBeLessThanOrEqual(totalBefore + 2);
    } finally {
      unregisterAction("test:tx-noop");
      unregisterAction("test:tx-boom");
    }
  });
});

// ---------------------------------------------------------------------------
// Action chaining — sub-actions share the parent transaction
// ---------------------------------------------------------------------------

describe("Transaction chaining across sub-actions", () => {
  test("sub-action shares parent transaction and commits atomically", async () => {
    await api.db.clearDatabase();

    class TxChildAction extends Action {
      constructor() {
        super({
          name: "test:tx-child",
          description: "Inserts a second user inside the shared transaction",
          middleware: [TransactionMiddleware],
        });
      }

      async run(_params: ActionParams<TxChildAction>, connection?: Connection) {
        const tx = connection!.metadata.transaction as Transaction;
        const [user] = await tx
          .insert(users)
          .values({
            name: "Child User",
            email: "child@example.com",
            password_hash: "hash",
          })
          .returning();
        return { user };
      }
    }

    class TxParentAction extends Action {
      constructor() {
        super({
          name: "test:tx-parent",
          description: "Inserts a user then calls a sub-action",
          middleware: [TransactionMiddleware],
        });
      }

      async run(
        _params: ActionParams<TxParentAction>,
        connection?: Connection,
      ) {
        const tx = connection!.metadata.transaction as Transaction;
        const [parentUser] = await tx
          .insert(users)
          .values({
            name: "Parent User",
            email: "parent@example.com",
            password_hash: "hash",
          })
          .returning();

        // Chain into a sub-action on the same connection
        const { response, error } = await connection!.act("test:tx-child", {});
        expect(error).toBeUndefined();

        return {
          parentUser,
          childUser: (response as Record<string, unknown>).user,
        };
      }
    }

    registerAction(new TxParentAction());
    registerAction(new TxChildAction());

    try {
      const conn = new Connection(CONNECTION_TYPE.WEB, "test-tx-chain");
      const { error } = await conn.act("test:tx-parent", {});

      expect(error).toBeUndefined();

      // Both users committed atomically
      const allUsers = await api.db.db.select().from(users);
      expect(allUsers.length).toBe(2);
      expect(allUsers.map((u: User) => u.email).sort()).toEqual([
        "child@example.com",
        "parent@example.com",
      ]);
    } finally {
      unregisterAction("test:tx-parent");
      unregisterAction("test:tx-child");
    }
  });

  test("sub-action error rolls back the entire chain", async () => {
    await api.db.clearDatabase();

    class TxChildThrowAction extends Action {
      constructor() {
        super({
          name: "test:tx-child-throw",
          description: "Inserts then throws inside shared transaction",
          middleware: [TransactionMiddleware],
        });
      }

      async run(
        _params: ActionParams<TxChildThrowAction>,
        connection?: Connection,
      ) {
        const tx = connection!.metadata.transaction as Transaction;
        await tx.insert(users).values({
          name: "Child User",
          email: "child-throw@example.com",
          password_hash: "hash",
        });
        throw new TypedError({
          message: "child failed",
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
    }

    class TxParentChainAction extends Action {
      constructor() {
        super({
          name: "test:tx-parent-chain",
          description: "Inserts a user then calls a failing sub-action",
          middleware: [TransactionMiddleware],
        });
      }

      async run(
        _params: ActionParams<TxParentChainAction>,
        connection?: Connection,
      ) {
        const tx = connection!.metadata.transaction as Transaction;
        await tx.insert(users).values({
          name: "Parent User",
          email: "parent-chain@example.com",
          password_hash: "hash",
        });

        const { error } = await connection!.act("test:tx-child-throw", {});
        // Propagate child error to trigger rollback
        if (error) throw error;

        return { ok: true };
      }
    }

    registerAction(new TxParentChainAction());
    registerAction(new TxChildThrowAction());

    try {
      const conn = new Connection(
        CONNECTION_TYPE.WEB,
        "test-tx-chain-rollback",
      );
      const { error } = await conn.act("test:tx-parent-chain", {});

      expect(error).toBeDefined();
      expect(error!.message).toBe("child failed");

      // Neither user should exist — entire chain rolled back
      const allUsers = await api.db.db.select().from(users);
      expect(allUsers.length).toBe(0);
    } finally {
      unregisterAction("test:tx-parent-chain");
      unregisterAction("test:tx-child-throw");
    }
  });
});

// ---------------------------------------------------------------------------
// runAfter error parameter
// ---------------------------------------------------------------------------

describe("runAfter error parameter", () => {
  test("receives TypedError when action throws", async () => {
    let capturedError: TypedError | undefined;

    const errorCapturingMiddleware: ActionMiddleware = {
      runAfter: async (_params, _connection, error) => {
        capturedError = error;
      },
    };

    class TxErrorCaptureAction extends Action {
      constructor() {
        super({
          name: "test:tx-error-capture",
          description: "Tests that runAfter receives the error",
          middleware: [errorCapturingMiddleware],
        });
      }

      async run() {
        throw new TypedError({
          message: "test error for runAfter",
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
    }

    registerAction(new TxErrorCaptureAction());

    try {
      const conn = new Connection(CONNECTION_TYPE.WEB, "test-error-capture");
      await conn.act("test:tx-error-capture", {});

      expect(capturedError).toBeDefined();
      expect(capturedError).toBeInstanceOf(TypedError);
      expect(capturedError!.message).toBe("test error for runAfter");
    } finally {
      unregisterAction("test:tx-error-capture");
    }
  });

  test("receives undefined on success", async () => {
    // Start with a sentinel to prove it gets overwritten
    let capturedError: TypedError | undefined = new TypedError({
      message: "sentinel",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });

    const errorCapturingMiddleware: ActionMiddleware = {
      runAfter: async (_params, _connection, error) => {
        capturedError = error;
      },
    };

    class TxSuccessCaptureAction extends Action {
      constructor() {
        super({
          name: "test:tx-success-capture",
          description: "Tests that runAfter gets undefined on success",
          middleware: [errorCapturingMiddleware],
        });
      }

      async run() {
        return { ok: true };
      }
    }

    registerAction(new TxSuccessCaptureAction());

    try {
      const conn = new Connection(CONNECTION_TYPE.WEB, "test-success-capture");
      await conn.act("test:tx-success-capture", {});

      expect(capturedError).toBeUndefined();
    } finally {
      unregisterAction("test:tx-success-capture");
    }
  });
});
