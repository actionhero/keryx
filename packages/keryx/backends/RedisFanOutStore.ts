import { api } from "../api";
import { FanOutStore } from "../classes/FanOutStore";
import type { FanOutStatus, TaskInputs } from "../initializers/actionts";

/**
 * The default {@link FanOutStore}, backed by Redis. Mirrors the original fan-out implementation:
 * batch metadata lives in a hash at `fanout:{id}`, results/errors in lists at
 * `fanout:{id}:results` / `fanout:{id}:errors`, all sharing a TTL that is refreshed on each write.
 */
export class RedisFanOutStore extends FanOutStore {
  async start() {}
  async stop() {}

  async create(
    fanOutId: string,
    total: number,
    actionNames: string[],
    queues: string[],
    ttlSeconds: number,
  ) {
    const metaKey = `fanout:${fanOutId}`;

    await api.redis.redis.hset(metaKey, {
      total: total.toString(),
      completed: "0",
      failed: "0",
      actionName: actionNames.join(","),
      queue: queues.join(","),
    });
    await api.redis.redis.expire(metaKey, ttlSeconds);

    // Pre-create results/errors lists with TTL so they exist for queries.
    await api.redis.redis.expire(`fanout:${fanOutId}:results`, ttlSeconds);
    await api.redis.redis.expire(`fanout:${fanOutId}:errors`, ttlSeconds);
  }

  async recordResult(fanOutId: string, params: TaskInputs, result: unknown) {
    const metaKey = `fanout:${fanOutId}`;
    const resultsKey = `fanout:${fanOutId}:results`;
    await api.redis.redis.rpush(resultsKey, JSON.stringify({ params, result }));
    await api.redis.redis.hincrby(metaKey, "completed", 1);
    await this.refreshTtl(fanOutId);
  }

  async recordError(fanOutId: string, params: TaskInputs, error: string) {
    const metaKey = `fanout:${fanOutId}`;
    const errorsKey = `fanout:${fanOutId}:errors`;
    await api.redis.redis.rpush(errorsKey, JSON.stringify({ params, error }));
    await api.redis.redis.hincrby(metaKey, "failed", 1);
    await this.refreshTtl(fanOutId);
  }

  async read(fanOutId: string): Promise<FanOutStatus> {
    const metaKey = `fanout:${fanOutId}`;
    const meta = await api.redis.redis.hgetall(metaKey);

    if (!meta || Object.keys(meta).length === 0) {
      return { total: 0, completed: 0, failed: 0, results: [], errors: [] };
    }

    const [rawResults, rawErrors] = await Promise.all([
      api.redis.redis.lrange(`fanout:${fanOutId}:results`, 0, -1),
      api.redis.redis.lrange(`fanout:${fanOutId}:errors`, 0, -1),
    ]);

    return {
      total: parseInt(meta.total, 10) || 0,
      completed: parseInt(meta.completed, 10) || 0,
      failed: parseInt(meta.failed, 10) || 0,
      results: rawResults.map((r: string) => JSON.parse(r)),
      errors: rawErrors.map((e: string) => JSON.parse(e)),
    };
  }

  /** Refresh the TTL on all three fan-out keys so they expire together. */
  private async refreshTtl(fanOutId: string) {
    const metaKey = `fanout:${fanOutId}`;
    const ttl = await api.redis.redis.ttl(metaKey);
    if (ttl > 0) {
      await api.redis.redis.expire(metaKey, ttl);
      await api.redis.redis.expire(`fanout:${fanOutId}:results`, ttl);
      await api.redis.redis.expire(`fanout:${fanOutId}:errors`, ttl);
    }
  }
}
