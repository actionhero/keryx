---
description: Sentry error monitoring and distributed tracing for Keryx — captures action exceptions and emits spans for HTTP, WebSocket, MCP, actions, tasks, Redis, and Postgres.
---

# Sentry

`@keryxjs/sentry` sends errors and traces from your Keryx app to [Sentry](https://sentry.io). It captures action exceptions and emits spans for HTTP, WebSocket, and MCP transports, action executions, background task enqueue/execute, Redis commands, and Postgres queries.

This plugin is independent of [`@keryxjs/tracing`](/plugins/tracing). Pick one: Sentry if you want issues and traces in Sentry, the OpenTelemetry plugin if you want OTLP (Jaeger, Tempo, Honeycomb, Datadog). Running both fights over the process-wide tracing context.

It can optionally send Sentry [logs and metrics](#logs-and-metrics) too — off by default. For Prometheus-style metrics scraped from your own process, see the built-in [Observability](/guide/observability) feature that ships with the core framework.

## Quick Start

Install the package:

```bash
bun add @keryxjs/sentry
```

Then register it in your plugins config:

```ts
// config/plugins.ts
import { sentryPlugin } from "@keryxjs/sentry";

export default {
  plugins: [sentryPlugin],
};
```

Set a DSN and start the app. The plugin turns itself on when `SENTRY_DSN` is present:

```bash
SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project> bun run start
```

To keep a DSN in the environment but stay dark (local, CI):

```bash
SENTRY_ENABLED=false bun run start
```

## Configuration

The plugin adds its own `config.sentry.*` namespace. All keys except the `beforeSend*` callbacks can be set via env vars at startup.

| Config Key                   | Env Var                        | Default              | Description                                                                 |
| ---------------------------- | ------------------------------ | -------------------- | --------------------------------------------------------------------------- |
| `sentry.enabled`             | `SENTRY_ENABLED`               | `true` when DSN set  | Master toggle                                                               |
| `sentry.dsn`                 | `SENTRY_DSN`                   | `""`                 | Sentry DSN. Required to send events                                         |
| `sentry.environment`         | `SENTRY_ENVIRONMENT`           | `""`                 | Environment tag (`production`, `staging`, …)                                |
| `sentry.release`             | `SENTRY_RELEASE`               | `""`                 | Release identifier attached to events and transactions                      |
| `sentry.tracesSampleRate`    | `SENTRY_TRACES_SAMPLE_RATE`    | `1.0`                | Trace sampling ratio (0–1). Lower this in production                        |
| `sentry.sendDefaultPii`      | `SENTRY_SEND_DEFAULT_PII`      | `false`              | Forward IP / user PII the SDK would otherwise drop                          |
| `sentry.debug`               | `SENTRY_DEBUG`                 | `false`              | Verbose Sentry SDK logging                                                  |
| `sentry.captureClientErrors` | `SENTRY_CAPTURE_CLIENT_ERRORS` | `false`              | Also capture 4xx `TypedError` failures (validation, not-found, auth)        |
| `sentry.enableLogs`          | `SENTRY_ENABLE_LOGS`           | `false`              | Send structured logs to Sentry (`Sentry.logger`), including a per-action log |
| `sentry.enableMetrics`       | `SENTRY_ENABLE_METRICS`        | `false`              | Send metrics to Sentry (`Sentry.metrics`), including a per-action counter    |
| `sentry.shutdownTimeoutMs`   | `SENTRY_SHUTDOWN_TIMEOUT_MS`   | `2000`               | Timeout for flushing events on shutdown                                     |
| `observability.serviceName`  | `OTEL_SERVICE_NAME`            | _(app name)_         | Service name set on the Sentry client (shared with core metrics)            |

`beforeSend`, `beforeSendSpan`, `beforeSendLog`, `beforeSendMetric`, and `transport` are config-only (not env vars). Use them to filter PII, drop noisy logs/metrics, or to swap the transport in tests.

## Logs and Metrics

Sentry [logs](https://docs.sentry.io/product/explore/logs/) and [metrics](https://docs.sentry.io/product/explore/metrics/) are opt-in. Both are off by default so existing installs keep sending only errors and traces.

Turn them on with `sentry.enableLogs=true` / `sentry.enableMetrics=true` (or the matching env vars). When enabled, the plugin instruments every action that runs:

- **Metric** — a counter named `keryx.action.count` is incremented once per action, with `keryx.action`, `keryx.connection.type`, and `keryx.action.success` attributes. Group by `keryx.action` in Sentry to see how often each action runs.
- **Log** — an `info` log (`action <name> ran`) with the same attributes plus `keryx.action.duration_ms`.

Both fire for every action across HTTP, WebSocket, CLI, background tasks, and MCP. Flipping the toggles also makes the SDK's log and metric APIs live, so you can emit your own from action code:

```ts
import * as Sentry from "@sentry/bun";

Sentry.metrics.count("orders.created", 1, { attributes: { plan: user.plan } });
Sentry.logger.info(Sentry.logger.fmt`charged ${user.id}`, { amount });
```

## What Gets Instrumented

| Span name                    | Op            | Attributes                                                                 | Notes                                                                                          |
| ---------------------------- | ------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `<METHOD>` / `GET status`    | `http.server` | `http.request.method`, `http.response.status_code`, `http.route`, `url.full` | Root HTTP span. Renamed to `<METHOD> <route>` once the action resolves                         |
| `ws.connect`                 | `ws.server`   | `keryx.connection.type`, `keryx.connection.id`                             | Opened on accept, ended on disconnect                                                          |
| `ws.message <type>`          | `ws.server`   | `keryx.ws.message_type`                                                    | Child of the connection span. Action messages stay open until `afterAct`                       |
| `mcp.connect`                | `mcp.server`  | `keryx.mcp.session_id`                                                     | Opened when the MCP session is initialized, ended on teardown                                  |
| `mcp.message`                | `mcp.server`  | `keryx.mcp.session_id`                                                     | Child of the session span. Ended when the action finishes or the session closes                |
| `task:<name>`                | `queue.process` | `keryx.action`, `keryx.connection.type`, `messaging.destination.name`     | Root transaction for a Resque job. Continues the enqueuer's trace when headers are present; otherwise starts a new trace |
| `action:<name>`              | `keryx.action` | `keryx.action`, `keryx.connection.type`, `keryx.action.duration_ms`        | Fires for every action across HTTP, WebSocket, CLI, background tasks, and MCP                  |
| `redis.<command>`            | `db`          | `db.system="redis"`, `db.operation.name`, `db.query.text`                  | `db.query.text` is `<command> <key1> <key2>…` — keys only, values are never captured           |
| `pg.<OP>`                    | `db`          | `db.system="postgresql"`, `db.operation.name`, `db.query.text`             | Wraps the node-postgres `Pool` Drizzle uses. SQL text up to 1000 chars; bind values are not    |

Spans nest naturally: the transport span (HTTP request, WebSocket message, MCP message, or background task) is the parent of the action span, which is the parent of any Redis / Postgres spans emitted during the action. Nested `connection.act()` calls stay in that same trace — the inner action is a child span, not a new transaction.

## Error Capture

Failed actions become Sentry issues when the error maps to HTTP 5xx (or is not a `TypedError`). Validation errors, 404s, and auth failures stay out of the issue stream unless you set `sentry.captureClientErrors=true`.

Each captured exception is tagged with `keryx.action` and `keryx.connection.type` so you can filter by action name and transport.

## Distributed Context Propagation

The plugin uses Sentry's native trace headers:

- **Incoming HTTP**: reads `sentry-trace` / `baggage` and links the request span to the caller's trace.
- **Outgoing tasks**: injects `_sentryTrace` / `_sentryBaggage` into background task params, so a worker picking up a job continues the originating trace.
- **Task execution**: extracts those fields, starts a root `queue.process` transaction (`task:<name>`), and strips the headers so they never reach the action's validated params. Scheduled jobs with no incoming headers still get their own root transaction. If that action then calls another action via `connection.act()`, the inner span stays on the same task trace — it does not open a second `task:` transaction.

## Programmatic Access

The plugin exposes `api.sentry` for manual capture from action code:

```ts
import { api } from "keryx";

api.sentry.setUser({ id: String(user.id), email: user.email });
api.sentry.setTag("plan", user.plan);

try {
  await charge(user);
} catch (e) {
  api.sentry.captureException(e);
  throw e;
}
```

`setUser` and `setTag` are scoped to the current action's request context, not the process. The identity you set is buffered per-request and applied to any `captureException` / `captureMessage` (and the automatic 5xx capture) that fires while handling that request, so it never bleeds onto a concurrent or later request's events.

When the plugin is disabled (no DSN, or `SENTRY_ENABLED=false`), every method is a no-op — `captureException()` returns `undefined` and `flush()` resolves `true`. Leave the calls in place; they cost nothing until you turn Sentry on.

For custom spans, import the SDK directly:

```ts
import * as Sentry from "@sentry/bun";

await Sentry.startSpan({ name: "charge.card", op: "task" }, async () => {
  await charge(user);
});
```

Child spans started this way pick up the active action as parent when they run inside `action.run()`.

## How It Works

The plugin is fully hook-based — it does **not** modify core Keryx code. It registers:

- `api.hooks.web.beforeRequest` / `afterRequest` — create and finalize the HTTP span
- `api.hooks.ws.onConnect` / `onMessage` / `onDisconnect` — WebSocket connection and message spans
- `api.hooks.mcp.onConnect` / `onMessage` / `onDisconnect` — MCP session and message spans
- `api.hooks.actions.beforeAct` / `afterAct` — create and finalize the action span; capture 5xx exceptions; emit the per-action log and metric when logs / metrics are enabled
- `api.hooks.actions.onEnqueue` — inject Sentry trace headers into task params
- `api.hooks.resque.beforeJob` / `afterJob` — create and finalize the root `queue.process` transaction (continuing the enqueuer's trace when headers are present)

The plugin also wraps `api.redis.redis.sendCommand` and the node-postgres `Pool` on `api.db.pool` after those initializers run. Only the checked-out client's `query` is wrapped (never `Pool.query`, which internally delegates to it), so each SQL statement is a single `pg.*` span. Drizzle goes through that pool, so `api.db.db.execute(...)` and query builders show up as `pg.*` spans.

Sentry's built-in `BunServer` integration is filtered out so you don't get a second, nameless HTTP transaction alongside the Keryx one.

The package also exports the underlying `SentryPlugin` initializer class alongside the `sentryPlugin` manifest. Registering the manifest is the supported path; reach for the class only when you need to subclass it or control its position in the initializer graph yourself.
