import type { KeryxPlugin } from "keryx";
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
};

export { TracingPlugin };
