---
description: OpenTelemetry-based metrics and distributed tracing for HTTP requests, WebSocket connections, action executions, and background tasks.
---

# Observability

The `@keryxjs/observability` plugin provides **OpenTelemetry metrics** and **distributed tracing** for HTTP requests, WebSocket connections, action executions, and background tasks. Both are disabled by default and controlled independently via environment variables.

## Installation

Install the plugin:

```bash
bun add @keryxjs/observability
```

Register it in `config/plugins.ts`:

```ts
import { observabilityPlugin } from "@keryxjs/observability";

export default {
  plugins: [observabilityPlugin],
};
```

## Quick Start

1. Enable metrics via environment variable:

```bash
OTEL_METRICS_ENABLED=true bun run start
```

2. Scrape metrics at `GET /metrics` (Prometheus exposition format).

## Configuration

| Config Key          | Env Var                       | Default                   | Description                                                                                |
| ------------------- | ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `enabled`           | `OTEL_METRICS_ENABLED`        | `false`                   | Toggle for metrics instrumentation                                                         |
| `metricsRoute`      | `OTEL_METRICS_ROUTE`          | `"/metrics"`              | Path for the Prometheus scrape endpoint                                                    |
| `serviceName`       | `OTEL_SERVICE_NAME`           | _(app name)_              | Service name for metrics and traces. Defaults to the `name` field from your `package.json` |
| `tracingEnabled`    | `OTEL_TRACING_ENABLED`        | `false`                   | Toggle for distributed tracing                                                             |
| `otlpEndpoint`      | `OTEL_EXPORTER_OTLP_ENDPOINT` | `"http://localhost:4318"` | OTLP collector endpoint for span export                                                    |
| `tracingSampleRate` | `OTEL_TRACING_SAMPLE_RATE`    | `1.0`                     | Fraction of traces to sample (0.0 to 1.0)                                                  |

## Available Metrics

### HTTP

| Metric                          | Type           | Attributes            | Description                       |
| ------------------------------- | -------------- | --------------------- | --------------------------------- |
| `keryx.http.requests`           | Counter        | method, route, status | Total HTTP requests received      |
| `keryx.http.request.duration`   | Histogram (ms) | method, route, status | HTTP request duration             |
| `keryx.http.active_connections` | UpDownCounter  | —                     | Currently active HTTP connections |

### WebSocket

| Metric                 | Type          | Attributes | Description                            |
| ---------------------- | ------------- | ---------- | -------------------------------------- |
| `keryx.ws.connections` | UpDownCounter | —          | Currently active WebSocket connections |
| `keryx.ws.messages`    | Counter       | —          | Total WebSocket messages received      |

### Actions

| Metric                    | Type           | Attributes     | Description               |
| ------------------------- | -------------- | -------------- | ------------------------- |
| `keryx.action.executions` | Counter        | action, status | Total action executions   |
| `keryx.action.duration`   | Histogram (ms) | action         | Action execution duration |

Action metrics are recorded for all transports (HTTP, WebSocket, CLI, background tasks, and MCP).

### Background Tasks

| Metric                | Type           | Attributes            | Description                     |
| --------------------- | -------------- | --------------------- | ------------------------------- |
| `keryx.task.enqueued` | Counter        | action, queue         | Total tasks enqueued            |
| `keryx.task.executed` | Counter        | action, queue, status | Total tasks executed by workers |
| `keryx.task.duration` | Histogram (ms) | action                | Task execution duration         |

### System

| Metric                     | Type             | Description                    |
| -------------------------- | ---------------- | ------------------------------ |
| `keryx.system.connections` | Observable Gauge | Current total connection count |

## Prometheus Integration

The `/metrics` endpoint serves metrics in [Prometheus exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/). Because each Keryx process serves its own `/metrics` endpoint, **every node in your cluster must be scraped individually** — metrics are not aggregated across instances. Use Prometheus service discovery or list each target explicitly.

Add a scrape target to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: "keryx"
    scrape_interval: 15s
    metrics_path: "/metrics"
    static_configs:
      - targets: ["localhost:8080"]
```

The metrics endpoint is served on the existing web server — no additional ports or servers needed. It's intercepted before action routing, so it won't conflict with your API routes. Keryx validates at startup that no action route overlaps with the metrics path.

## Custom Exporters

The built-in `/metrics` endpoint covers the Prometheus pull model. For push-based exporters (OTLP, Datadog, etc.), configure your own `MeterProvider` before calling `api.start()`:

```ts
import { metrics } from "@opentelemetry/api";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const exporter = new OTLPMetricExporter({
  url: "https://your-collector:4318/v1/metrics",
});

const provider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 30_000,
    }),
  ],
});

metrics.setGlobalMeterProvider(provider);
```

Keryx's instruments use the global OTel API, so they'll automatically report to whatever `MeterProvider` is registered.

## Programmatic Access

You can collect metrics programmatically via `api.observability.collectMetrics()`:

```ts
import { api } from "keryx";

const prometheusText = await api.observability.collectMetrics();
```

The instruments are also available directly for custom recording:

```ts
api.observability.http.requestsTotal.add(1, {
  method: "GET",
  route: "/custom",
  status: "200",
});
api.observability.action.duration.record(42, { action: "myAction" });
```

## Cardinality & Memory

All built-in metric attributes have bounded cardinality — they use action names, HTTP methods, status codes, and queue names, all of which are known at startup. This means the number of unique time series stays proportional to your action count and memory usage remains constant regardless of traffic volume.

If you record custom metrics via `api.observability`, avoid using unbounded values (user IDs, request paths, timestamps, etc.) as attributes. Unbounded cardinality causes the OTel SDK to allocate a new time series per unique combination, which can lead to unbounded memory growth.

## Distributed Tracing

Keryx supports OpenTelemetry distributed tracing with automatic span creation, W3C trace context propagation, and OTLP export. Enable it independently from metrics.

### Quick Start

1. Start an OTLP collector (e.g., [Jaeger](https://www.jaegertracing.io/), [Grafana Tempo](https://grafana.com/oss/tempo/), or the [OTel Collector](https://opentelemetry.io/docs/collector/)):

```bash
docker run -d --name jaeger -p 4318:4318 -p 16686:16686 jaegertracing/all-in-one
```

2. Enable tracing:

```bash
OTEL_TRACING_ENABLED=true bun run start
```

3. Make a request and view traces at `http://localhost:16686`.

### What Gets Traced

Keryx automatically creates spans for:

- **HTTP requests** — A `{METHOD} {route}` span (e.g. `GET status`) wraps each request with attributes `http.request.method`, `http.route`, `http.response.status_code`, and `url.full` (stable OTel semconv v1.20+).
- **Action execution** — An `action:{name}` child span tracks the full action lifecycle (middleware, validation, run) with attributes `keryx.action`, `keryx.connection.type`, and `keryx.action.duration_ms`.
- **Database queries** — A `drizzle.{operation}` child span is created for each Drizzle query (via [`@kubiks/otel-drizzle`](https://www.npmjs.com/package/@kubiks/otel-drizzle)) with `db.system`, `db.statement`, and `db.operation` attributes including full timing data.
- **Redis commands** — A `redis.{command}` span is created for each Redis command with `db.system.name` and `db.operation.name` attributes.

### W3C Trace Context Propagation

Keryx extracts the `traceparent` and `tracestate` headers from incoming HTTP requests ([W3C Trace Context](https://www.w3.org/TR/trace-context/)). This means requests from upstream services automatically participate in the same distributed trace.

### Task Trace Propagation

When an action enqueues a background task (via `api.actions.enqueue()` or `api.actions.fanOut()`), the current trace context is automatically injected into the task params as `_traceParent` and `_traceState`. When the worker picks up the task, the trace context is restored so the task's spans appear as children of the original request trace.

### Sampling

Use `OTEL_TRACING_SAMPLE_RATE` to control what fraction of traces are sampled. The default is `1.0` (all traces). In production, consider lowering this to reduce export volume:

```bash
OTEL_TRACING_ENABLED=true OTEL_TRACING_SAMPLE_RATE=0.1 bun run start
```

### Custom OTLP Endpoint

Point spans at your collector:

```bash
OTEL_TRACING_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=https://your-collector:4318 bun run start
```

Spans are exported via OTLP/HTTP to `{endpoint}/v1/traces` using `BatchSpanProcessor` for efficient batching. Tune the batch processor with:

| Env Var | Default | Description |
|---------|---------|-------------|
| `OTEL_SPAN_QUEUE_SIZE` | 2048 | Max spans queued before dropping |
| `OTEL_SPAN_BATCH_SIZE` | 512 | Max spans per export batch |
| `OTEL_SPAN_EXPORT_DELAY_MS` | 5000 | Delay between scheduled exports |
| `OTEL_SPAN_SHUTDOWN_TIMEOUT_MS` | 5000 | Timeout for flushing spans on shutdown |
