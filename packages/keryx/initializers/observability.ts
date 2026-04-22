import { metrics } from "@opentelemetry/api";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import path from "path";
import { api, logger } from "../api";
import { Initializer } from "../classes/Initializer";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";

const namespace = "observability";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Observability["initialize"]>>;
  }
}

/**
 * Observability initializer — provides OpenTelemetry-based metrics for HTTP requests,
 * WebSocket connections, action executions, and background tasks.
 *
 * Enable via `OTEL_METRICS_ENABLED=true`. The built-in Prometheus scrape endpoint is
 * served at `config.observability.metricsRoute` (default `/metrics`) on the existing
 * web server.
 */
export class Observability extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["actions", "connections"];
  }

  async initialize() {
    const noopAdd = (
      _value: number,
      _attributes?: Record<string, string>,
    ) => {};
    const noopRecord = (
      _value: number,
      _attributes?: Record<string, string>,
    ) => {};
    return {
      enabled: false,
      http: {
        requestsTotal: { add: noopAdd },
        requestDuration: { record: noopRecord },
        activeConnections: { add: noopAdd },
      },
      ws: { connections: { add: noopAdd }, messagesTotal: { add: noopAdd } },
      action: {
        executionsTotal: { add: noopAdd },
        duration: { record: noopRecord },
      },
      task: {
        enqueuedTotal: { add: noopAdd },
        executedTotal: { add: noopAdd },
        duration: { record: noopRecord },
      },
      collectMetrics: async () => "" as string,
    };
  }

  async start() {
    if (!config.observability.enabled) return;

    // Validate no action route conflicts with the metrics route
    const metricsRoute = config.observability.metricsRoute;
    const apiRoute = config.server.web.apiRoute;
    for (const action of api.actions.actions) {
      if (!action.web?.route) continue;
      const route = action.web.route;

      if (route instanceof RegExp) {
        const metricsPathWithoutApi = metricsRoute.startsWith(apiRoute)
          ? metricsRoute.slice(apiRoute.length)
          : null;
        if (
          metricsPathWithoutApi !== null &&
          route.test(metricsPathWithoutApi)
        ) {
          throw new TypedError({
            message: `Metrics route "${metricsRoute}" conflicts with action "${action.name}" route pattern ${route}`,
            type: ErrorType.INITIALIZER_VALIDATION,
          });
        }
      } else {
        const fullRoute = apiRoute + route;
        if (fullRoute === metricsRoute) {
          throw new TypedError({
            message: `Metrics route "${metricsRoute}" conflicts with action "${action.name}" route "${fullRoute}"`,
            type: ErrorType.INITIALIZER_VALIDATION,
          });
        }
      }
    }

    // Resolve service name: env var > app package.json name > "keryx"
    let serviceName = config.observability.serviceName;
    if (!serviceName) {
      try {
        const pkgPath = path.join(api.rootDir, "package.json");
        const pkg = await Bun.file(pkgPath).json();
        serviceName = pkg.name || "keryx";
      } catch {
        serviceName = "keryx";
      }
    }

    // Create a MetricReader so we can collect on demand for the /metrics endpoint
    const reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryExporter(),
      exportIntervalMillis: 60_000, // we mostly collect on demand
      exportTimeoutMillis: 10_000,
    });

    const meterProvider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
    const meter = meterProvider.getMeter(serviceName);

    const ns = api.observability;
    ns.enabled = true;

    // --- HTTP Metrics ---
    ns.http.requestsTotal = meter.createCounter("keryx.http.requests", {
      description: "Total number of HTTP requests received",
    });
    ns.http.requestDuration = meter.createHistogram(
      "keryx.http.request.duration",
      { description: "HTTP request duration in milliseconds", unit: "ms" },
    );
    ns.http.activeConnections = meter.createUpDownCounter(
      "keryx.http.active_connections",
      { description: "Number of active HTTP connections" },
    );

    // --- WebSocket Metrics ---
    ns.ws.connections = meter.createUpDownCounter("keryx.ws.connections", {
      description: "Number of active WebSocket connections",
    });
    ns.ws.messagesTotal = meter.createCounter("keryx.ws.messages", {
      description: "Total WebSocket messages received",
    });

    // --- Action Metrics ---
    ns.action.executionsTotal = meter.createCounter("keryx.action.executions", {
      description: "Total action executions",
    });
    ns.action.duration = meter.createHistogram("keryx.action.duration", {
      description: "Action execution duration in milliseconds",
      unit: "ms",
    });

    // --- Task Metrics ---
    ns.task.enqueuedTotal = meter.createCounter("keryx.task.enqueued", {
      description: "Total tasks enqueued",
    });
    ns.task.executedTotal = meter.createCounter("keryx.task.executed", {
      description: "Total tasks executed by workers",
    });
    ns.task.duration = meter.createHistogram("keryx.task.duration", {
      description: "Task execution duration in milliseconds",
      unit: "ms",
    });

    // --- System Metrics (observable gauges) ---
    meter
      .createObservableGauge("keryx.system.connections", {
        description: "Current number of connections",
      })
      .addCallback((result) => {
        if (api.connections?.connections) {
          result.observe(api.connections.connections.size);
        }
      });

    ns.collectMetrics = async () => {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors?.length) {
        logger.warn(`Metrics collection errors: ${errors.join(", ")}`);
      }
      return serializeToPrometheus(resourceMetrics);
    };

    logger.info(`Observability initialized (service: ${serviceName})`);
  }

  async stop() {
    // Reset to no-ops so the next start() cycle can re-initialize cleanly.
    // MeterProvider is intentionally NOT shut down — shutting it down would
    // make the reader unable to collect, but start() may create a new one.
    // In production stop() is called right before process exit.
    const noopAdd = (
      _value: number,
      _attributes?: Record<string, string>,
    ) => {};
    const noopRecord = (
      _value: number,
      _attributes?: Record<string, string>,
    ) => {};
    const ns = api.observability;
    ns.enabled = false;
    ns.http.requestsTotal = { add: noopAdd };
    ns.http.requestDuration = { record: noopRecord };
    ns.http.activeConnections = { add: noopAdd };
    ns.ws.connections = { add: noopAdd };
    ns.ws.messagesTotal = { add: noopAdd };
    ns.action.executionsTotal = { add: noopAdd };
    ns.action.duration = { record: noopRecord };
    ns.task.enqueuedTotal = { add: noopAdd };
    ns.task.executedTotal = { add: noopAdd };
    ns.task.duration = { record: noopRecord };
    ns.collectMetrics = async () => "";
  }
}

/**
 * A no-op exporter that discards all data. We use PeriodicExportingMetricReader
 * only for its `collect()` method — actual export happens via our `/metrics` route.
 */
class InMemoryExporter {
  export(_metrics: any, resultCallback: (result: { code: number }) => void) {
    resultCallback({ code: 0 });
  }
  async shutdown() {}
  async forceFlush() {}
}

// --- Prometheus text format serialization ---

/**
 * Serialize OTel ResourceMetrics to Prometheus exposition format.
 * Supports Counter, Histogram, Gauge, and UpDownCounter metric types.
 */
function serializeToPrometheus(resourceMetrics: any): string {
  const lines: string[] = [];

  for (const scopeMetrics of resourceMetrics?.scopeMetrics ?? []) {
    for (const metric of scopeMetrics.metrics ?? []) {
      const name = sanitizeMetricName(metric.descriptor.name);
      const help = metric.descriptor.description || "";
      const type = otelTypeToPrometheus(metric.descriptor.type);

      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);

      for (const dp of metric.dataPoints ?? []) {
        const labels = formatLabels(dp.attributes ?? {});

        if (type === "histogram") {
          serializeHistogramDataPoint(lines, name, labels, dp);
        } else {
          const value =
            typeof dp.value === "number" ? dp.value : Number(dp.value);
          lines.push(`${name}${labels} ${value}`);
        }
      }
    }
  }

  return lines.join("\n") + "\n";
}

function sanitizeMetricName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_:]/g, "_");
}

// OTel DataPointType values (from @opentelemetry/sdk-metrics)
const HISTOGRAM_TYPE = 0;
const SUM_TYPE = 1;
const GAUGE_TYPE = 2;
const EXPONENTIAL_HISTOGRAM_TYPE = 3;

function otelTypeToPrometheus(type: number): string {
  switch (type) {
    case HISTOGRAM_TYPE:
    case EXPONENTIAL_HISTOGRAM_TYPE:
      return "histogram";
    case GAUGE_TYPE:
      return "gauge";
    case SUM_TYPE:
    default:
      return "gauge"; // counters are exported as gauges in prometheus for simplicity; real distinction via _total suffix
  }
}

function formatLabels(attributes: Record<string, any>): string {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return "";
  const parts = entries.map(
    ([k, v]) =>
      `${sanitizeMetricName(k)}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
  );
  return `{${parts.join(",")}}`;
}

function serializeHistogramDataPoint(
  lines: string[],
  name: string,
  labels: string,
  dp: any,
): void {
  const boundaries: number[] = dp.value?.buckets?.boundaries ?? [];
  const counts: number[] = dp.value?.buckets?.counts ?? [];
  let cumulative = 0;

  for (let i = 0; i < boundaries.length; i++) {
    cumulative += counts[i] ?? 0;
    const le = boundaries[i];
    const bucketLabels = labels
      ? labels.slice(0, -1) + `,le="${le}"}`
      : `{le="${le}"}`;
    lines.push(`${name}_bucket${bucketLabels} ${cumulative}`);
  }

  // +Inf bucket
  cumulative += counts[boundaries.length] ?? 0;
  const infLabels = labels
    ? labels.slice(0, -1) + `,le="+Inf"}`
    : `{le="+Inf"}`;
  lines.push(`${name}_bucket${infLabels} ${cumulative}`);
  lines.push(`${name}_sum${labels} ${dp.value?.sum ?? 0}`);
  lines.push(`${name}_count${labels} ${dp.value?.count ?? 0}`);
}
