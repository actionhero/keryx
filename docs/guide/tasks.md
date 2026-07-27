---
description: Background tasks with Resque workers and the fan-out pattern for distributing work across child jobs.
---

# Background Tasks

One of the things I've always loved about ActionHero is that background tasks are a first-class citizen — not a plugin, not a separate service, just part of the framework. Keryx keeps that tradition, using [pg-boss](https://github.com/timgit/pg-boss) for job processing backed by Postgres.

The key difference from the original ActionHero: tasks and actions are the same thing now. Any action can be scheduled as a background job by adding a `task` property. Same inputs, same validation, same `run()` method.

## Defining a Task

```ts
export class MessagesCleanup implements Action {
  name = "messages:cleanup";
  description = "Cleanup messages older than 24 hours";
  task = { queue: "default", frequency: 1000 * 60 * 60 }; // every hour
  inputs = z.object({
    age: z.coerce
      .number()
      .int()
      .min(1000)
      .default(1000 * 60 * 60 * 24),
  });

  async run(params: ActionParams<MessagesCleanup>) {
    const deleted = await api.db.db
      .delete(messages)
      .where(lt(messages.createdAt, new Date(Date.now() - params.age)))
      .returning();
    return { messagesDeleted: deleted.length };
  }
}
```

- **`queue`** — which Resque queue to put this job on (required)
- **`frequency`** — how often to run it, in milliseconds (optional — omit for one-shot tasks)

You can also run this same action from the CLI (`./keryx.ts "messages:cleanup" --age 3600000 -q`) or hit it via HTTP if you add a `web` property. It's all the same code.

## Queue Priority

Workers drain queues left-to-right. This matters when you want some jobs to take priority:

```ts
// In config/tasks.ts
queues: ["worker", "scheduler"];
// Jobs on "worker" are processed before "scheduler"
```

Use `["*"]` to process all queues with equal priority. That said, for fan-out patterns (see below), you'll probably want to separate parent tasks from child tasks so the children get processed first.

## Fan-Out Pattern

This is one of my favorite features. A parent task can distribute work across many child jobs for parallel processing using `api.actions.fanOut()`. Think "process all users" where you fan out to individual "process one user" jobs.

### Single Action Fan-Out

The simple case — bulk-enqueue the same action with different inputs:

```ts
export class ProcessAllUsers implements Action {
  name = "users:processAll";
  task = { frequency: 1000 * 60 * 60, queue: "scheduler" };

  async run() {
    const users = await getActiveUsers();
    const result = await api.actions.fanOut(
      "users:processOne",
      users.map((u) => ({ userId: u.id })),
      "worker",
    );
    return { fanOut: result };
  }
}

// The child action — nothing special needed here
export class ProcessOneUser implements Action {
  name = "users:processOne";
  task = { queue: "worker" };
  inputs = z.object({ userId: z.string() });
  async run(params) {
    /* process one user */
  }
}
```

The child action doesn't know or care that it was spawned by a fan-out. It's just a regular action.

### Multi-Action Fan-Out

You can also fan out to different action types in one batch:

```ts
const result = await api.actions.fanOut([
  { action: "users:processOne", inputs: { userId: "1" } },
  { action: "users:processOne", inputs: { userId: "2" } },
  { action: "emails:send", inputs: { to: "a@b.com" }, queue: "priority" },
]);
```

### Checking Results

```ts
const status = await api.actions.fanOutStatus(result.fanOutId);
// → { total: 3, completed: 3, failed: 0, results: [...], errors: [...] }
```

Results and metadata are stored in Postgres with a configurable TTL (default 10 minutes). The TTL refreshes on each child job completion, so it's relative to the last activity — not the fan-out creation time.

### How Fan-Out Works Internally

When you call `fanOut()`, each child job gets a `_fanOutId` injected into its inputs automatically. The child action doesn't need to know about this — after each job completes, the shared task runner checks for `_fanOutId` and records the result (or error) in the fan-out store. This means any existing action works as a fan-out child with zero changes.

Fan-out state lives in two framework-managed Postgres tables, created automatically at boot:

- `keryx_fanout` — one row per operation with the counters (total, completed, failed) and an `expires_at`
- `keryx_fanout_events` — one row per child result/error, cascade-deleted with its operation

### Error Handling

If a child job fails, it's recorded in the errors list. The fan-out doesn't abort — other children continue processing. Use `fanOutStatus()` to check for failures:

```ts
const status = await api.actions.fanOutStatus(result.fanOutId);
if (status.failed > 0) {
  for (const error of status.errors) {
    logger.error(`Failed for ${JSON.stringify(error.params)}: ${error.error}`);
  }
}
```

Enqueue-time errors (e.g., invalid action name) are returned immediately in the `FanOutResult.errors` array, separate from runtime errors collected via `fanOutStatus()`.

### Options

- **`batchSize`** — how many jobs to enqueue per batch (default: 100). Jobs are enqueued in batches to avoid one giant transaction.
- **`resultTtl`** — how long to keep results, in seconds (default: 600). The TTL refreshes on each child completion, so it's relative to the last activity — not the fan-out creation time.

### Additional Task APIs

Beyond fan-out, the actions initializer exposes the rest of the task-management API:

```ts
// Schedule for later
await api.actions.enqueueAt(timestamp, "actionName", inputs, queue);
await api.actions.enqueueIn(delayMs, "actionName", inputs, queue);

// Inspect queues
const jobs = await api.actions.queued("default", 0, 100);
const scheduled = await api.actions.scheduledAt("default", "actionName", inputs);

// Manage failures
const failedCount = await api.actions.failedCount();
const failures = await api.actions.failed(0, 10);
await api.actions.retryAndRemoveFailed(failedJob);

// Recurrent task control
await api.actions.stopRecurrentAction("messages:cleanup");

// Full system overview
const details = await api.actions.taskDetails();
// → { queues, workers, stats, leader }
```

## The Postgres Backend

Background tasks run on **Postgres**, via [pg-boss](https://github.com/timgit/pg-boss) — no Redis required for the task system. pg-boss uses `SELECT ... FOR UPDATE SKIP LOCKED` for exactly-once dequeue among concurrent workers, and owns/migrates its own schema (`config.tasks.pgBoss.schema`, default `keryx_tasks`) at boot. The Postgres fan-out store creates its `keryx_fanout` / `keryx_fanout_events` tables the same way, so there are no manual migrations to run.

The public task interface (`api.actions.enqueue`, `enqueueIn`, `enqueueAt`, `fanOut`, `fanOutStatus`, `taskDetails`, `stopRecurrentAction`, and `Action.task`) sits on top of a thin seam you can reach directly for advanced use:

```ts
api.tasks.backend; // the TaskBackend (pg-boss)
api.tasks.fanOutStore; // the FanOutStore (Postgres)
```

`TaskBackend` / `FanOutStore` are abstract, so the storage engine is a swappable seam — but only the Postgres implementations ship today.

### Recurring tasks are single-instance without a leader

No elected leader is needed to keep a recurring task from piling up across a multi-process cluster. Recurring actions are routed to a dedicated pg-boss queue created with the `short` policy, whose unique index allows only one *pending* (`created`) job per action across the whole cluster. The slot frees the moment the job starts running, so the job's own "re-enqueue myself" step still succeeds while every concurrent duplicate is rejected. N processes all enqueuing the same recurring action at boot results in exactly one pending copy.
