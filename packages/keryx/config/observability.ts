import { loadFromEnvIfSet } from "../util/config";

export const configObservability = {
  enabled: await loadFromEnvIfSet("OTEL_METRICS_ENABLED", false),
  metricsRoute: await loadFromEnvIfSet("OTEL_METRICS_ROUTE", "/metrics"),
  serviceName: await loadFromEnvIfSet("OTEL_SERVICE_NAME", ""),
};
