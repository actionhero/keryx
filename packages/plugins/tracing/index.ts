import type { KeryxPlugin } from "keryx";
import { loadFromEnvIfSet } from "keryx";
import { TracingPlugin } from "./initializer";
import pkg from "./package.json" with { type: "json" };

/**
 * The `@keryxjs/tracing` plugin — OpenTelemetry distributed tracing for Keryx
 * applications. Emits spans for HTTP requests, actions, background tasks,
 * Redis commands, and Drizzle DB queries; exports via OTLP.
 *
 * Metrics are handled by the core `Observability` initializer — this plugin
 * is tracing-only.
 *
 * Register in `config/plugins.ts`:
 * ```ts
 * import { tracingPlugin } from "@keryxjs/tracing";
 * export default { plugins: [tracingPlugin] };
 * ```
 *
 * Then enable via environment variable:
 * - `OTEL_TRACING_ENABLED=true` — OTLP span export to `OTEL_EXPORTER_OTLP_ENDPOINT`
 */
export const tracingPlugin: KeryxPlugin = {
  name: pkg.name,
  version: pkg.version,
  initializers: [TracingPlugin],
  configDefaults: {
    tracing: {
      enabled: await loadFromEnvIfSet("OTEL_TRACING_ENABLED", false),
      otlpEndpoint: await loadFromEnvIfSet(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "http://localhost:4318",
      ),
      sampleRate: await loadFromEnvIfSet("OTEL_TRACING_SAMPLE_RATE", 1.0),
      spanQueueSize: await loadFromEnvIfSet("OTEL_SPAN_QUEUE_SIZE", 2048),
      spanBatchSize: await loadFromEnvIfSet("OTEL_SPAN_BATCH_SIZE", 512),
      spanExportDelayMs: await loadFromEnvIfSet(
        "OTEL_SPAN_EXPORT_DELAY_MS",
        5000,
      ),
      spanShutdownTimeoutMs: await loadFromEnvIfSet(
        "OTEL_SPAN_SHUTDOWN_TIMEOUT_MS",
        5000,
      ),
    },
  },
};

declare module "keryx" {
  interface KeryxConfig {
    tracing: {
      /** Master toggle for distributed tracing. Off by default. */
      enabled: boolean;
      /** OTLP HTTP receiver endpoint. */
      otlpEndpoint: string;
      /** Head-based sampling ratio (0–1). */
      sampleRate: number;
      /** Maximum spans queued before dropping. */
      spanQueueSize: number;
      /** Max spans exported per batch. */
      spanBatchSize: number;
      /** Delay in ms between scheduled span exports. */
      spanExportDelayMs: number;
      /** Timeout in ms for flushing pending spans on shutdown. */
      spanShutdownTimeoutMs: number;
    };
  }
}

export { TracingPlugin };
