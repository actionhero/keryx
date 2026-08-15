import type { AsyncLocalStorage } from "node:async_hooks";
import * as Sentry from "@sentry/bun";
import { api } from "keryx";
import {
  buildRedisQueryText,
  finishSpan,
  pgOperation,
  queryTextFromArgs,
  type SentrySpan,
  truncateSql,
} from "./spanHelpers";

type SpanStore = AsyncLocalStorage<SentrySpan | undefined>;

/**
 * Wrap ioredis `sendCommand` on the main Redis client to emit a span per
 * command. Only the general-purpose client is instrumented; the subscription
 * client uses a different command flow for SUBSCRIBE/PSUBSCRIBE.
 *
 * Span `db.query.text` captures `<command> <key1> <key2>...` — keys only,
 * never values.
 *
 * @param spanALS - Async store holding the active parent span so each Redis
 *   span nests under the current request / action span.
 */
export function instrumentRedis(spanALS: SpanStore) {
  const client = api.redis?.redis;
  if (!client) return;
  const originalSendCommand = client.sendCommand.bind(client);
  client.sendCommand = function (
    ...args: Parameters<typeof originalSendCommand>
  ) {
    const [command] = args;
    const commandName = (command as { name?: string }).name ?? "unknown";
    const queryText = buildRedisQueryText(command, commandName);
    const span = Sentry.startInactiveSpan({
      name: `redis.${commandName}`,
      op: "db",
      parentSpan: spanALS.getStore(),
      attributes: {
        "db.system": "redis",
        "db.operation.name": commandName,
        "db.query.text": queryText,
      },
    });
    return finishSpan(span, originalSendCommand(...args)) as ReturnType<
      typeof originalSendCommand
    >;
  } as typeof client.sendCommand;
}

/**
 * Wrap the node-postgres `Pool` used by Drizzle so every SQL command
 * (including those issued through `api.db.db`) becomes a Sentry span.
 * Query text is captured up to 1000 characters; bind values are not.
 *
 * Only the checked-out client's `query` is wrapped — never `Pool.query`.
 * `Pool.query` internally acquires a client via `Pool.connect` and delegates
 * to `client.query`, so wrapping both would emit two stacked `pg.*` spans per
 * statement. Wrapping only the client covers direct `Pool.query`, pooled
 * clients, and transactions with exactly one span each. Wrapped clients are
 * tracked in a `WeakSet` so pooled clients (reused across checkouts) are
 * never re-wrapped, which would otherwise grow the wrapper chain unbounded.
 *
 * @param spanALS - Async store holding the active parent span so each Postgres
 *   span nests under the current request / action span.
 */
export function instrumentPostgres(spanALS: SpanStore) {
  const pool = (
    api as {
      db?: {
        pool?: {
          connect: (...args: unknown[]) => unknown;
        };
      };
    }
  ).db?.pool;
  if (!pool) return;

  const wrappedClients = new WeakSet<object>();
  const wrapClient = (client: { query: (...args: unknown[]) => unknown }) => {
    if (wrappedClients.has(client)) return;
    wrappedClients.add(client);
    const originalClientQuery = client.query.bind(client);
    client.query = (...args: unknown[]) => {
      const sqlText = queryTextFromArgs(args);
      const span = Sentry.startInactiveSpan({
        name: `pg.${pgOperation(sqlText)}`,
        op: "db",
        parentSpan: spanALS.getStore(),
        attributes: {
          "db.system": "postgresql",
          "db.operation.name": pgOperation(sqlText),
          "db.query.text": truncateSql(sqlText),
        },
      });
      // `Pool.query` calls `client.query(text, values, cb)` with a callback;
      // node-postgres returns a `Query` (not a thenable) in that form, so end
      // the span when the callback fires rather than immediately.
      const last = args[args.length - 1];
      if (typeof last === "function") {
        const cb = last as (...a: unknown[]) => unknown;
        args[args.length - 1] = (
          err: Error | undefined,
          ...rest: unknown[]
        ) => {
          if (err) {
            span.setStatus({ code: 2, message: err.message });
          } else {
            span.setStatus({ code: 1 });
          }
          span.end();
          return cb(err, ...rest);
        };
        return originalClientQuery(...args);
      }
      return finishSpan(span, originalClientQuery(...args));
    };
  };

  const originalConnect = pool.connect.bind(pool);
  pool.connect = (...args: unknown[]) => {
    const cb = args[0];
    if (typeof cb === "function") {
      return originalConnect(
        (
          err: Error | undefined,
          client: { query: (...args: unknown[]) => unknown },
          done: unknown,
        ) => {
          if (client) wrapClient(client);
          return (cb as (...a: unknown[]) => unknown)(err, client, done);
        },
      );
    }
    const result = originalConnect(...args);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      return (
        result as Promise<{ query: (...args: unknown[]) => unknown }>
      ).then((client) => {
        wrapClient(client);
        return client;
      });
    }
    return result;
  };
}
