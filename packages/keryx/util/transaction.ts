import { drizzle } from "drizzle-orm/bun-sql";
import { api, logger } from "../api";
import { ErrorType, TypedError } from "../classes/TypedError";

/**
 * A Drizzle database instance scoped to a single PostgreSQL transaction.
 * Returned by {@link withTransaction} and stored on `connection.metadata.transaction`
 * by `TransactionMiddleware`. Shares the same query-builder interface as `api.db.db`,
 * so ops functions can accept either without changing their query code.
 */
export type Transaction = ReturnType<typeof drizzle>;

/**
 * Union of the top-level Drizzle database and a transaction-scoped instance.
 * Use this as the `db` parameter type in ops/helper functions so callers can
 * pass either `api.db.db` (no transaction) or a `Transaction` from middleware.
 *
 * @example
 * ```ts
 * import { api, type DbOrTransaction } from "keryx";
 * import { users } from "../schema/users";
 *
 * export async function findUserByEmail(email: string, db: DbOrTransaction = api.db.db) {
 *   return db.select().from(users).where(eq(users.email, email)).limit(1);
 * }
 * ```
 */
export type DbOrTransaction = ReturnType<typeof drizzle>;

/**
 * Run a callback inside a database transaction with automatic commit/rollback.
 *
 * Uses Drizzle's built-in `.transaction()` method which manages BEGIN/COMMIT/ROLLBACK
 * automatically via Bun.sql's connection reservation. If `fn` resolves, the
 * transaction is committed; if it throws, the transaction is rolled back and
 * the error is re-thrown.
 *
 * For request-scoped transactions that span middleware + action execution,
 * use `TransactionMiddleware` instead — it manages the same lifecycle
 * automatically via `connection.metadata.transaction`.
 *
 * @param fn - Async callback that receives a transaction-scoped Drizzle instance.
 *   All queries executed through `tx` participate in the same transaction.
 * @returns The value returned by `fn`.
 * @throws {TypedError} Re-throws `TypedError` directly. Wraps other errors in
 *   a `TypedError` with `ErrorType.CONNECTION_ACTION_RUN`.
 *
 * @example
 * ```ts
 * const user = await withTransaction(async (tx) => {
 *   const [created] = await tx.insert(users).values({ name: "Alice" }).returning();
 *   await tx.insert(auditLogs).values({ action: "user:create", userId: created.id });
 *   return created;
 * });
 * ```
 */
export async function withTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    const db = api.db.db;
    const result = await db.transaction(
      // @ts-ignore transaction callback parameter type varies across drizzle contexts
      async (tx: Transaction) => {
        return await fn(tx);
      },
    );
    logger.debug("transaction committed");
    return result;
  } catch (e) {
    logger.debug("transaction rolled back");
    if (e instanceof TypedError) throw e;
    throw new TypedError({
      message: `${e}`,
      type: ErrorType.CONNECTION_ACTION_RUN,
      originalError: e,
    });
  }
}
