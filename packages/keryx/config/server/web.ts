import { loadFromEnvIfSet } from "../../util/config";

const port = await loadFromEnvIfSet("WEB_SERVER_PORT", 8080);
const host = await loadFromEnvIfSet("WEB_SERVER_HOST", "localhost");

export const configServerWeb = {
  enabled: await loadFromEnvIfSet("WEB_SERVER_ENABLED", true),
  port,
  host,
  applicationUrl: await loadFromEnvIfSet(
    "APPLICATION_URL",
    `http://${host}:${port}`,
  ),
  apiRoute: await loadFromEnvIfSet("WEB_SERVER_API_ROUTE", "/api"),
  allowedOrigins: await loadFromEnvIfSet("WEB_SERVER_ALLOWED_ORIGINS", "*"),
  allowedMethods: await loadFromEnvIfSet(
    "WEB_SERVER_ALLOWED_METHODS",
    "HEAD, GET, POST, PUT, PATCH, DELETE, OPTIONS",
  ),
  allowedHeaders: await loadFromEnvIfSet(
    "WEB_SERVER_ALLOWED_HEADERS",
    "Content-Type",
  ),
  staticFiles: {
    enabled: await loadFromEnvIfSet("WEB_SERVER_STATIC_ENABLED", true),
    directory: await loadFromEnvIfSet("WEB_SERVER_STATIC_DIRECTORY", "assets"),
    route: await loadFromEnvIfSet("WEB_SERVER_STATIC_ROUTE", "/"),
    cacheControl: await loadFromEnvIfSet(
      "WEB_SERVER_STATIC_CACHE_CONTROL",
      "public, max-age=3600",
    ),
    etag: await loadFromEnvIfSet("WEB_SERVER_STATIC_ETAG", true),
  },
  websocket: {
    maxPayloadSize: await loadFromEnvIfSet("WS_MAX_PAYLOAD_SIZE", 65_536),
    maxMessagesPerSecond: await loadFromEnvIfSet(
      "WS_MAX_MESSAGES_PER_SECOND",
      20,
    ),
    maxSubscriptions: await loadFromEnvIfSet("WS_MAX_SUBSCRIPTIONS", 100),
    drainTimeout: await loadFromEnvIfSet("WS_DRAIN_TIMEOUT", 5000),
  },
  includeStackInErrors: await loadFromEnvIfSet(
    "WEB_SERVER_INCLUDE_STACK_IN_ERRORS",
    (Bun.env.NODE_ENV ?? "development") !== "production",
  ),
  securityHeaders: {
    "Content-Security-Policy": await loadFromEnvIfSet(
      "WEB_SECURITY_CSP",
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: blob:; connect-src 'self'; worker-src blob:",
    ),
    "X-Content-Type-Options": await loadFromEnvIfSet(
      "WEB_SECURITY_CONTENT_TYPE_OPTIONS",
      "nosniff",
    ),
    "X-Frame-Options": await loadFromEnvIfSet(
      "WEB_SECURITY_FRAME_OPTIONS",
      "DENY",
    ),
    "Strict-Transport-Security": await loadFromEnvIfSet(
      "WEB_SECURITY_HSTS",
      "max-age=31536000; includeSubDomains",
    ),
    "Referrer-Policy": await loadFromEnvIfSet(
      "WEB_SECURITY_REFERRER_POLICY",
      "strict-origin-when-cross-origin",
    ),
  } as Record<string, string>,
  maxBodySize: await loadFromEnvIfSet("WEB_MAX_BODY_SIZE", 10 * 1024 * 1024),
  compression: {
    enabled: await loadFromEnvIfSet("WEB_COMPRESSION_ENABLED", true),
    threshold: await loadFromEnvIfSet("WEB_COMPRESSION_THRESHOLD", 1024),
    encodings: ["br", "gzip"] as ("br" | "gzip")[],
  },
  correlationId: {
    header: await loadFromEnvIfSet("WEB_CORRELATION_ID_HEADER", "X-Request-Id"),
    trustProxy: await loadFromEnvIfSet("WEB_CORRELATION_ID_TRUST_PROXY", false),
  },
};
