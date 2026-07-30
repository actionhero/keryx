import { api, logger } from "../api";
import { FanOutStore } from "../classes/FanOutStore";
import type { FanOutStatus, TaskInputs } from "../initializers/actionts";

const FANOUT_TABLE = "keryx_fanout";
const EVENTS_TABLE = "keryx_fanout_events";

/**
 * A Postgres-backed {@link FanOutStore} so fan-out state lives alongside a `pg-boss` deployment with
 * no Redis. Owns two framework-managed tables created on demand at {@link PgFanOutStore.start}:
 * `keryx_fanout` (one row per batch, with counters and an `expires_at`) and `keryx_fanout_events`
 * (one row per child result/error, cascade-deleted with its batch). TTL is enforced two ways: reads
 * ignore rows past `expires_at`, and `start()` prunes expired batches.
 *
 * Tables are created programmatically (rather than via a Drizzle migration) so the framework owns
 * them for every consuming app without requiring each app to ship a migration.
 */
export class PgFanOutStore extends FanOutStore {
  private query<T extends Record<string, any> = any>(
    text: string,
    values: any[] = [],
  ) {
    return api.db.pool.query<T>(text, values);
  }

  async start() {
    await this.query(`
      CREATE TABLE IF NOT EXISTS ${FANOUT_TABLE} (
        id TEXT PRIMARY KEY,
        total INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        action_names TEXT NOT NULL DEFAULT '',
        queues TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.query(`
      CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
        id BIGSERIAL PRIMARY KEY,
        fanout_id TEXT NOT NULL REFERENCES ${FANOUT_TABLE}(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        params JSONB NOT NULL DEFAULT '{}'::jsonb,
        payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.query(
      `CREATE INDEX IF NOT EXISTS ${EVENTS_TABLE}_fanout_id_idx ON ${EVENTS_TABLE} (fanout_id)`,
    );

    // Boot-time TTL sweep: drop expired batches (events cascade).
    try {
      await this.query(`DELETE FROM ${FANOUT_TABLE} WHERE expires_at < now()`);
    } catch (e) {
      logger.debug(`[fanout:postgres] expiry sweep skipped: ${e}`);
    }
  }

  async stop() {}

  async create(
    fanOutId: string,
    total: number,
    actionNames: string[],
    queues: string[],
    ttlSeconds: number,
  ) {
    await this.query(
      `INSERT INTO ${FANOUT_TABLE} (id, total, completed, failed, action_names, queues, expires_at)
       VALUES ($1, $2, 0, 0, $3, $4, now() + ($5 || ' seconds')::interval)
       ON CONFLICT (id) DO NOTHING`,
      [
        fanOutId,
        total,
        actionNames.join(","),
        queues.join(","),
        String(ttlSeconds),
      ],
    );
  }

  async recordResult(fanOutId: string, params: TaskInputs, result: unknown) {
    await this.query(
      `INSERT INTO ${EVENTS_TABLE} (fanout_id, kind, params, payload) VALUES ($1, 'result', $2::jsonb, $3::jsonb)`,
      [fanOutId, JSON.stringify(params ?? {}), JSON.stringify(result ?? null)],
    );
    await this.query(
      `UPDATE ${FANOUT_TABLE} SET completed = completed + 1 WHERE id = $1`,
      [fanOutId],
    );
  }

  async recordError(fanOutId: string, params: TaskInputs, error: string) {
    await this.query(
      `INSERT INTO ${EVENTS_TABLE} (fanout_id, kind, params, payload) VALUES ($1, 'error', $2::jsonb, $3::jsonb)`,
      [fanOutId, JSON.stringify(params ?? {}), JSON.stringify(error)],
    );
    await this.query(
      `UPDATE ${FANOUT_TABLE} SET failed = failed + 1 WHERE id = $1`,
      [fanOutId],
    );
  }

  async read(fanOutId: string): Promise<FanOutStatus> {
    const meta = await this.query<{
      total: number;
      completed: number;
      failed: number;
    }>(
      `SELECT total, completed, failed FROM ${FANOUT_TABLE} WHERE id = $1 AND expires_at > now()`,
      [fanOutId],
    );

    if (meta.rows.length === 0) {
      return { total: 0, completed: 0, failed: 0, results: [], errors: [] };
    }

    const events = await this.query<{
      kind: string;
      params: any;
      payload: any;
    }>(
      `SELECT kind, params, payload FROM ${EVENTS_TABLE} WHERE fanout_id = $1 ORDER BY id`,
      [fanOutId],
    );

    const results: FanOutStatus["results"] = [];
    const errors: FanOutStatus["errors"] = [];
    for (const e of events.rows) {
      if (e.kind === "error") {
        errors.push({ params: e.params, error: String(e.payload) });
      } else {
        results.push({ params: e.params, result: e.payload });
      }
    }

    return {
      total: meta.rows[0].total,
      completed: meta.rows[0].completed,
      failed: meta.rows[0].failed,
      results,
      errors,
    };
  }
}
