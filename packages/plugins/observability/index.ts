import type { KeryxPlugin } from "keryx";
import { ObservabilityPlugin } from "./initializer";

/**
 * The `@keryxjs/observability` plugin — OpenTelemetry metrics and distributed
 * tracing for Keryx applications.
 *
 * Register in `config/plugins.ts`:
 * ```ts
 * import { observabilityPlugin } from "@keryxjs/observability";
 * export default { plugins: [observabilityPlugin] };
 * ```
 *
 * Then enable via environment variables:
 * - `OTEL_METRICS_ENABLED=true` — Prometheus scrape endpoint at `/metrics`
 * - `OTEL_TRACING_ENABLED=true` — OTLP span export to `OTEL_EXPORTER_OTLP_ENDPOINT`
 */
export const observabilityPlugin: KeryxPlugin = {
  name: "@keryxjs/observability",
  version: "0.2.0",
  initializers: [ObservabilityPlugin],
};

export { ObservabilityPlugin };
