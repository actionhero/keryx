import { randomUUID } from "crypto";
import { Plugin } from "node-resque";
import { api, config, logger } from "../api";

type Lease = { token: string; timer: ReturnType<typeof setInterval> };

/** Leases held by workers in this process, keyed by Redis lock key. */
const leases = new Map<string, Lease>();

/**
 * node-resque plugin that keeps two copies of a recurring task (one with a `frequency`)
 * from running at the same time, without stalling the task when a worker dies mid-run.
 *
 * It replaces node-resque's `JobLock` for recurring tasks, which differs in two ways:
 * - `JobLock` holds its lock for an hour. If the process dies mid-run (a crash, an OOM,
 *   SIGKILL, an initializer that fails during `start()`), nothing releases the lock, and every
 *   run is refused until it expires. This plugin holds a short lease
 *   (`config.tasks.recurringLockTimeout`) instead, renewed while the job runs, so a dead
 *   worker's lock expires within one lease.
 * - When `JobLock` refuses a run, the job is dropped, and since the job never runs, it never
 *   re-enqueues itself: the recurring chain ends. This plugin re-arms the chain when it
 *   refuses a run, so the task keeps being tried every `frequency`.
 *
 * The lock key is the same one `JobLock` uses (`resque:workerslock:<action>:<queue>:<args>`),
 * so a lock left by an older keryx version still guards against an overlapping run.
 */
export class RecurringTaskLock extends Plugin {
  async beforeEnqueue() {
    return true;
  }

  async afterEnqueue() {
    return true;
  }

  async beforePerform() {
    const key = this.key();
    const redis = this.queueObject.connection.redis;
    const leaseMs = config.tasks.recurringLockTimeout;
    const token = randomUUID();

    const acquired = await redis.set(key, token, "PX", leaseMs, "NX");
    if (acquired === "OK") {
      const timer = setInterval(
        () => {
          renewLease(redis, key, token, leaseMs).catch((error) => {
            logger.warn(`[resque] could not renew lock ${key}: ${error}`);
          });
        },
        Math.max(Math.floor(leaseMs / 3), 1),
      );
      leases.set(key, { token, timer });
      return true;
    }

    // Another worker holds the lock (or held it and died). Re-arm the chain so the task
    // is tried again after `frequency` instead of going silent.
    const action = api.actions.actions.find((a) => a.name === this.func);
    if (action) await api.actions.enqueueRecurrent(action);
    logger.debug(
      `[resque] ${this.func} is locked by another run, re-enqueued for later`,
    );
    return false;
  }

  async afterPerform() {
    const key = this.key();
    const lease = leases.get(key);
    if (!lease) return true;

    clearInterval(lease.timer);
    leases.delete(key);
    const redis = this.queueObject.connection.redis;
    if ((await redis.get(key)) === lease.token) await redis.del(key);
    return true;
  }

  key() {
    return this.queueObject.connection.key(
      "workerslock",
      this.func,
      this.queue,
      JSON.stringify(this.args),
    );
  }
}

async function renewLease(
  redis: RecurringTaskLock["queueObject"]["connection"]["redis"],
  key: string,
  token: string,
  leaseMs: number,
) {
  if (leases.get(key)?.token !== token) return;
  if ((await redis.get(key)) === token) await redis.pexpire(key, leaseMs);
}
