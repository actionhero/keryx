import type { ReservedSQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { api, logger } from "../api";
import type { ActionMiddleware } from "../classes/Action";
import type { Connection } from "../classes/Connection";
import type { TypedError } from "../classes/TypedError";
import type { Transaction } from "../util/transaction";

/**
 * Action middleware that wraps the entire action execution in a database transaction.
 *
 * In `runBefore`, a dedicated connection is reserved from `api.db.client` via
 * `sql.reserve()`, a `BEGIN` is issued, and a transaction-scoped Drizzle instance
 * is stored on `connection.metadata.transaction`. Actions and ops functions should
 * use this instance (instead of `api.db.db`) for all queries that must be atomic.
 *
 * In `runAfter`, the transaction is committed on success or rolled back if the
 * action threw an error. The reserved connection is always released.
 *
 * **Re-entrant**: When a parent action already opened a transaction (e.g., via
 * `connection.act()` chaining), the middleware reuses the existing transaction
 * instead of opening a new one. Only the outermost middleware instance commits
 * or rolls back.
 *
 * @example
 * ```ts
 * import { Action, HTTP_METHOD, TransactionMiddleware, type ActionParams, type Connection } from "keryx";
 *
 * export class TransferFunds extends Action {
 *   constructor() {
 *     super({
 *       name: "transfer:funds",
 *       middleware: [SessionMiddleware, TransactionMiddleware],
 *       web: { route: "/transfer", method: HTTP_METHOD.POST },
 *       inputs: z.object({ fromId: z.number(), toId: z.number(), amount: z.number() }),
 *     });
 *   }
 *
 *   async run(params: ActionParams<TransferFunds>, connection: Connection) {
 *     const tx = connection.metadata.transaction;
 *     await tx.update(accounts).set(...).where(eq(accounts.id, params.fromId));
 *     await tx.update(accounts).set(...).where(eq(accounts.id, params.toId));
 *     return { success: true };
 *   }
 * }
 * ```
 */
export const TransactionMiddleware: ActionMiddleware = {
  runBefore: async (
    _params: Record<string, unknown>,
    connection: Connection,
  ) => {
    // If a parent action already opened a transaction, reuse it.
    // Track depth so only the outermost middleware commits/rolls back.
    const depth = (connection.metadata._txDepth as number | undefined) ?? 0;
    connection.metadata._txDepth = depth + 1;

    if (depth > 0) return; // already inside a transaction — nothing to do

    const reserved: ReservedSQL = await api.db.client.reserve();
    await reserved`BEGIN`;
    const tx = drizzle({ client: reserved }) as unknown as Transaction;
    connection.metadata.transaction = tx;
    connection.metadata._txReserved = reserved;
  },

  runAfter: async (
    _params: Record<string, unknown>,
    connection: Connection,
    error?: TypedError,
  ) => {
    const depth = (connection.metadata._txDepth as number | undefined) ?? 0;
    connection.metadata._txDepth = Math.max(0, depth - 1);

    // Only the outermost middleware manages the transaction lifecycle
    if (depth > 1) return;

    const reserved = connection.metadata._txReserved as ReservedSQL | undefined;
    if (!reserved) return;

    try {
      if (error) {
        await reserved`ROLLBACK`;
        logger.debug("transaction rolled back");
      } else {
        await reserved`COMMIT`;
        logger.debug("transaction committed");
      }
    } finally {
      reserved.release();
      connection.metadata.transaction = undefined;
      connection.metadata._txReserved = undefined;
    }
  },
};
