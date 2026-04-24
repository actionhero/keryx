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

type MeterAdd = (value: number, attributes?: Record<string, string>) => void;
type MeterRecord = (value: number, attributes?: Record<string, string>) => void;

interface HttpMeters {
  requestsTotal: { add: MeterAdd };
  requestDuration: { record: MeterRecord };
}
interface WsMeters {
  connections: { add: MeterAdd };
  messagesTotal: { add: MeterAdd };
}
interface McpMeters {
  sessions: { add: MeterAdd };
  messagesTotal: { add: MeterAdd };
}
interface ActionMeters {
  executionsTotal: { add: MeterAdd };
  duration: { record: MeterRecord };
}
interface TaskMeters {
  enqueuedTotal: { add: MeterAdd };
  executedTotal: { add: MeterAdd };
  duration: { record: MeterRecord };
}

const noopAdd: MeterAdd = () => {};
const noopRecord: MeterRecord = () => {};
const noopHttp = (): HttpMeters => ({
  requestsTotal: { add: noopAdd },
  requestDuration: { record: noopRecord },
});
const noopWs = (): WsMeters => ({
  connections: { add: noopAdd },
  messagesTotal: { add: noopAdd },
});
const noopMcp = (): McpMeters => ({
  sessions: { add: noopAdd },
  messagesTotal: { add: noopAdd },
});
const noopAction = (): ActionMeters => ({
  executionsTotal: { add: noopAdd },
  duration: { record: noopRecord },
});
const noopTask = (): TaskMeters => ({
  enqueuedTotal: { add: noopAdd },
  executedTotal: { add: noopAdd },
  duration: { record: noopRecord },
});

/**
 * Observability initializer — provides OpenTelemetry-based metrics for HTTP requests,
 * WebSocket connections, action executions, and background tasks.
 *
 * Enable via `OTEL_METRICS_ENABLED=true`. The built-in Prometheus scrape endpoint is
 * served at `config.observability.metricsRoute` (default `/metrics`) on the existing
 * web server.
 *
 * All emission is wired through `api.hooks.*` — call sites elsewhere in the framework
 * do not reference `api.observability` directly. Meter instruments are private to the
 * initializer; apps that need custom metrics should create their own `Meter` off the
 * global OTel `MeterProvider` that this initializer installs.
 */
export class Observability extends Initializer {
  private httpMeters: HttpMeters = noopHttp();
  private wsMeters: WsMeters = noopWs();
  private mcpMeters: McpMeters = noopMcp();
  private actionMeters: ActionMeters = noopAction();
  private taskMeters: TaskMeters = noopTask();

  constructor() {
    super(namespace);
    this.dependsOn = ["hooks", "actions", "connections"];
  }

  async initialize() {
    const ns = {
      enabled: false,
      collectMetrics: async () => "" as string,
    };

    api.hooks.actions.afterAct((actionName, _params, _conn, _ctx, outcome) => {
      this.actionMeters.executionsTotal.add(1, {
        action: actionName,
        status: outcome.success ? "success" : "error",
      });
      this.actionMeters.duration.record(outcome.duration, {
        action: actionName,
      });
    });

    api.hooks.actions.onEnqueue((actionName, _inputs, queue) => {
      this.taskMeters.enqueuedTotal.add(1, { action: actionName, queue });
    });

    api.hooks.resque.afterJob((actionName, _params, ctx, outcome) => {
      this.taskMeters.executedTotal.add(1, {
        action: actionName,
        queue: ctx.queue,
        status: outcome.success ? "success" : "failure",
      });
      this.taskMeters.duration.record(outcome.duration, {
        action: actionName,
      });
    });

    api.hooks.web.afterRequest((_req, _res, _ctx, outcome) => {
      const labels = {
        method: outcome.method,
        route: outcome.actionName ?? "unknown",
        status: String(outcome.status),
      };
      this.httpMeters.requestsTotal.add(1, labels);
      this.httpMeters.requestDuration.record(outcome.durationMs, labels);
    });

    api.hooks.ws.onConnect(() => {
      this.wsMeters.connections.add(1);
    });
    api.hooks.ws.onMessage(() => {
      this.wsMeters.messagesTotal.add(1);
    });
    api.hooks.ws.onDisconnect(() => {
      this.wsMeters.connections.add(-1);
    });

    api.hooks.mcp.onConnect(() => {
      this.mcpMeters.sessions.add(1);
    });
    api.hooks.mcp.onMessage(() => {
      this.mcpMeters.messagesTotal.add(1);
    });
    api.hooks.mcp.onDisconnect(() => {
      this.mcpMeters.sessions.add(-1);
    });

    return ns;
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

    this.httpMeters = {
      requestsTotal: meter.createCounter("keryx.http.requests", {
        description: "Total number of HTTP requests received",
      }),
      requestDuration: meter.createHistogram("keryx.http.request.duration", {
        description: "HTTP request duration in milliseconds",
        unit: "ms",
      }),
    };

    this.wsMeters = {
      connections: meter.createUpDownCounter("keryx.ws.connections", {
        description: "Number of active WebSocket connections",
      }),
      messagesTotal: meter.createCounter("keryx.ws.messages", {
        description: "Total WebSocket messages received",
      }),
    };

    this.mcpMeters = {
      sessions: meter.createUpDownCounter("keryx.mcp.sessions", {
        description: "Number of active MCP sessions",
      }),
      messagesTotal: meter.createCounter("keryx.mcp.messages", {
        description: "Total MCP requests received",
      }),
    };

    this.actionMeters = {
      executionsTotal: meter.createCounter("keryx.action.executions", {
        description: "Total action executions",
      }),
      duration: meter.createHistogram("keryx.action.duration", {
        description: "Action execution duration in milliseconds",
        unit: "ms",
      }),
    };

    this.taskMeters = {
      enqueuedTotal: meter.createCounter("keryx.task.enqueued", {
        description: "Total tasks enqueued",
      }),
      executedTotal: meter.createCounter("keryx.task.executed", {
        description: "Total tasks executed by workers",
      }),
      duration: meter.createHistogram("keryx.task.duration", {
        description: "Task execution duration in milliseconds",
        unit: "ms",
      }),
    };

    // System gauge — reads directly from api.connections at scrape time
    meter
      .createObservableGauge("keryx.system.connections", {
        description: "Current number of connections",
      })
      .addCallback((result) => {
        if (api.connections?.connections) {
          result.observe(api.connections.connections.size);
        }
      });

    api.observability.collectMetrics = async () => {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors?.length) {
        logger.warn(`Metrics collection errors: ${errors.join(", ")}`);
      }
      return serializeToPrometheus(resourceMetrics);
    };
    api.observability.enabled = true;

    logger.info(`Observability initialized (service: ${serviceName})`);
  }

  async stop() {
    // Reset meters to no-ops so the next start() cycle can re-initialize cleanly.
    // MeterProvider is intentionally NOT shut down — shutting it down would
    // make the reader unable to collect, but start() may create a new one.
    // In production stop() is called right before process exit.
    this.httpMeters = noopHttp();
    this.wsMeters = noopWs();
    this.mcpMeters = noopMcp();
    this.actionMeters = noopAction();
    this.taskMeters = noopTask();
    api.observability.collectMetrics = async () => "";
    api.observability.enabled = false;
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
