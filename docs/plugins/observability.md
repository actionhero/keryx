---
description: OpenTelemetry-based metrics for HTTP requests, WebSocket connections, action executions, and background tasks — with a built-in Prometheus scrape endpoint.
---

# Observability

Keryx includes built-in OpenTelemetry instrumentation that provides metrics for HTTP requests, WebSocket connections, action executions, and background tasks. Disabled by default — enable it and scrape `/metrics` for Prometheus.

## Quick Start

1. Enable metrics via environment variable:

```bash
OTEL_METRICS_ENABLED=true bun run start
```

2. Scrape metrics at `GET /metrics` (Prometheus exposition format).

## Configuration

| Config Key     | Env Var                | Default      | Description                                                                                |
| -------------- | ---------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `enabled`      | `OTEL_METRICS_ENABLED` | `false`      | Master toggle for all instrumentation                                                      |
| `metricsRoute` | `OTEL_METRICS_ROUTE`   | `"/metrics"` | Path for the Prometheus scrape endpoint                                                    |
| `serviceName`  | `OTEL_SERVICE_NAME`    | _(app name)_ | Service name in metric labels. Defaults to the `name` field from your app's `package.json` |

## Available Metrics

### HTTP

| Metric                        | Type           | Attributes            | Description                  |
| ----------------------------- | -------------- | --------------------- | ---------------------------- |
| `keryx.http.requests`         | Counter        | method, route, status | Total HTTP requests received |
| `keryx.http.request.duration` | Histogram (ms) | method, route, status | HTTP request duration        |

### WebSocket

| Metric                 | Type          | Attributes | Description                            |
| ---------------------- | ------------- | ---------- | -------------------------------------- |
| `keryx.ws.connections` | UpDownCounter | —          | Currently active WebSocket connections |
| `keryx.ws.messages`    | Counter       | —          | Total WebSocket messages received      |

### MCP

| Metric                | Type          | Attributes | Description                                          |
| --------------------- | ------------- | ---------- | ---------------------------------------------------- |
| `keryx.mcp.sessions`  | UpDownCounter | —          | Currently active MCP sessions                        |
| `keryx.mcp.messages`  | Counter       | —          | Total MCP requests received (POST/GET/DELETE)        |

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

## Custom Metrics

The built-in meter instruments are private to the observability initializer — framework emission is wired through `api.hooks.*`, and no direct `api.observability.*.add/record` surface is exposed. To record your own metrics, create a `Meter` off the global OTel `MeterProvider` that Keryx installs at `start()`:

```ts
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("my-app");
const signupsTotal = meter.createCounter("my_app.signups", {
  description: "Total user signups",
});

signupsTotal.add(1, { plan: "pro" });
```

Your custom metrics will be exported alongside Keryx's built-in metrics on the same `/metrics` endpoint.

## Cardinality & Memory

All built-in metric attributes have bounded cardinality — they use action names, HTTP methods, status codes, and queue names, all of which are known at startup. This means the number of unique time series stays proportional to your action count and memory usage remains constant regardless of traffic volume.

If you record custom metrics via your own `Meter`, avoid using unbounded values (user IDs, request paths, timestamps, etc.) as attributes. Unbounded cardinality causes the OTel SDK to allocate a new time series per unique combination, which can lead to unbounded memory growth.
