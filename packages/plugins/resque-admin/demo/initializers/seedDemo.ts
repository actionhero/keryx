import { api, Initializer, logger } from "keryx";

const LOCK_KEY = "resque-admin:demo-seeded";
const LOCK_TTL_SECONDS = 60;

export class SeedDemoTasks extends Initializer {
  constructor() {
    super("seedDemoTasks");
    this.dependsOn = ["redis", "actions", "resque"];
    this.declaresAPIProperty = false;
  }

  async start() {
    if (process.env.RESQUE_ADMIN_SEED_DEMO !== "1") return;

    const acquired = await api.redis.redis.set(
      LOCK_KEY,
      "1",
      "EX",
      LOCK_TTL_SECONDS,
      "NX",
    );
    if (!acquired) {
      logger.info(
        "[resque-admin demo] seed lock held — skipping (another boot seeded within the last minute)",
      );
      return;
    }

    const now = Date.now();
    const slowSuccess = Array.from({ length: 20 }, () =>
      api.actions.enqueue("demo:slowSuccess"),
    );
    const flaky = Array.from({ length: 15 }, () =>
      api.actions.enqueue("demo:flaky"),
    );
    const delayedSoon = Array.from({ length: 3 }, (_, i) =>
      api.actions.enqueueIn(
        60_000 + i * 10_000,
        "demo:alwaysFails",
        {},
        "critical",
      ),
    );
    const delayedFar = Array.from({ length: 2 }, (_, i) =>
      api.actions.enqueueAt(
        now + (24 + i) * 60 * 60 * 1000,
        "demo:alwaysFails",
        {},
        "critical",
      ),
    );

    await Promise.all([
      ...slowSuccess,
      ...flaky,
      ...delayedSoon,
      ...delayedFar,
    ]);

    logger.info(
      "[resque-admin demo] seeded 20 slowSuccess + 15 flaky + 5 delayed alwaysFails jobs",
    );
  }
}
