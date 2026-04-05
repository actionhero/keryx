---
description: Modular configuration with per-environment overrides via environment variables.
---

# Configuration

Config in Keryx is statically defined at boot — there's no dynamic config reloading. That said, every config value supports per-environment overrides via environment variables, so you can set things differently in test, development, and production without touching code.

## Structure

Config is split into modules:

```
backend/config/
├── index.ts        # Aggregates everything into one `config` object
├── actions.ts      # Action timeout, fan-out batch size and TTL
├── channels.ts     # Presence TTL and heartbeat interval
├── database.ts     # Database connection string, auto-migrate flag
├── logger.ts       # Log level, timestamps, colors, output format (text/JSON)
├── observability.ts # OpenTelemetry metrics toggle, route, service name
├── process.ts      # Process name, shutdown timeout
├── rateLimit.ts    # Rate limiting windows and thresholds
├── redis.ts        # Redis connection string
├── session.ts      # Session TTL, cookie security flags
├── tasks.ts        # Task queue settings
└── server/
    ├── cli.ts      # CLI error display, quiet mode
    ├── web.ts      # Web server port, CORS, security headers, WS limits
    └── mcp.ts      # MCP server toggle, route, OAuth TTLs, markdown depth limit
```

Everything rolls up into a single `config` object:

```ts
import { config } from "../config";

config.database.connectionString; // Postgres URL
config.server.web.port; // 8080
config.logger.level; // "info"
```

## Custom Config

You can add your own config modules alongside the built-in ones. Create a new file in your `config/` directory, then aggregate it in `config/index.ts`:

```ts
// config/audit.ts
import { loadFromEnvIfSet } from "keryx";

export const configAudit = {
  retentionDays: await loadFromEnvIfSet("AUDIT_RETENTION_DAYS", 30),
  enabled: await loadFromEnvIfSet("AUDIT_ENABLED", true),
};
```

```ts
// config/index.ts
import { configAudit } from "./audit";

export default {
  audit: configAudit,
};
```

At boot, Keryx deep-merges your config into the framework's `config` object, so `config.audit.retentionDays` works at runtime. To get full type safety, augment the `KeryxConfig` interface:

```ts
// config/audit.ts (add at the bottom)
declare module "keryx" {
  interface KeryxConfig {
    audit: typeof configAudit;
  }
}
```

Now `config.audit.retentionDays` is fully typed everywhere you import `config` from `"keryx"` — no casts needed.

## Environment Overrides

The `loadFromEnvIfSet()` helper is where the magic happens:

```ts
import { loadFromEnvIfSet } from "../util/config";

export const configDatabase = {
  connectionString: await loadFromEnvIfSet("DATABASE_URL", "x"),
  autoMigrate: await loadFromEnvIfSet("DATABASE_AUTO_MIGRATE", true),
};
```

The resolution order is:

1. `DATABASE_URL_TEST` (env var with `NODE_ENV` suffix — checked first)
2. `DATABASE_URL` (plain env var)
3. `"x"` (the default value)

This means you can set `DATABASE_URL_TEST=postgres://localhost/bun-test` and it'll automatically be used when `NODE_ENV=test`, without any conditional logic in your config files.

The helper is also type-aware — it parses `"true"`/`"false"` strings into booleans and numeric strings into numbers. So `DATABASE_AUTO_MIGRATE=false` does what you'd expect.

## Reference

### Actions

| Key               | Env Var                     | Default          | Description                                     |
| ----------------- | --------------------------- | ---------------- | ----------------------------------------------- |
| `timeout`         | `ACTION_TIMEOUT`            | `300000` (5 min) | Global action execution timeout in ms (0 = off) |
| `fanOutBatchSize` | `ACTION_FAN_OUT_BATCH_SIZE` | `100`            | Max jobs enqueued per Redis round-trip          |
| `fanOutResultTtl` | `ACTION_FAN_OUT_RESULT_TTL` | `600` (10 min)   | TTL in seconds for fan-out result keys in Redis |

### Database

| Key                | Env Var                 | Default |
| ------------------ | ----------------------- | ------- |
| `connectionString` | `DATABASE_URL`          | `"x"`   |
| `autoMigrate`      | `DATABASE_AUTO_MIGRATE` | `true`  |

#### Advanced: Pool Tuning

The database connection pool defaults are suitable for development and most production workloads. If you need to tune pool behavior — for example, to match your database's `max_connections` limit or to reduce idle resource usage — you can override these settings via environment variables.

| Key                            | Env Var                         | Default | Description                                                                           |
| ------------------------------ | ------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `pool.max`                     | `DATABASE_POOL_MAX`             | `10`    | Maximum number of connections in the pool                                             |
| `pool.idleTimeoutMillis`       | `DATABASE_POOL_IDLE_TIMEOUT`    | `10000` | How long (ms) a connection can sit idle before being closed (converted to seconds)    |
| `pool.connectionTimeoutMillis` | `DATABASE_POOL_CONNECT_TIMEOUT` | `0`     | Max time (ms) to wait for a connection from the pool (0 = use Bun.sql default of 30s) |

These values are passed to Bun's native `SQL` client. A common production override:

```bash
DATABASE_POOL_MAX=25
DATABASE_POOL_IDLE_TIMEOUT=30000
DATABASE_POOL_CONNECT_TIMEOUT=5000
```

### Logger

| Key                 | Env Var                  | Default  | Description                                                                           |
| ------------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------- |
| `level`             | `LOG_LEVEL`              | `"info"` | Minimum log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`)                |
| `includeTimestamps` | `LOG_INCLUDE_TIMESTAMPS` | `true`   | Prepend ISO-8601 timestamp to each log line                                           |
| `colorize`          | `LOG_COLORIZE`           | `true`   | Apply ANSI color codes (text format only)                                             |
| `format`            | `LOG_FORMAT`             | `"text"` | Output format: `"text"` for human-readable, `"json"` for structured NDJSON            |
| `maxParamLength`    | `LOG_MAX_PARAM_LENGTH`   | `100`    | Max length of individual param values in action logs before truncation (0 = no limit) |

In JSON mode, each log line is a single JSON object with `timestamp`, `level`, `message`, and `pid` fields. Action and task logs include additional structured fields like `action`, `duration`, `status`, `method`, `url`, `correlationId`, `queue`, and `jobClass` — making them easy to parse with log aggregation systems (ELK, Datadog, CloudWatch, Loki, etc.).

```bash
# Enable JSON logging in production
LOG_FORMAT=json bun run start
```

Example JSON output:

```json
{
  "timestamp": "2025-01-15T10:30:00.000Z",
  "level": "info",
  "message": "action: status",
  "pid": 12345,
  "action": "status",
  "connectionType": "web",
  "status": "OK",
  "duration": 12,
  "method": "GET",
  "url": "/api/status"
}
```

### Redis

| Key                | Env Var     | Default                      |
| ------------------ | ----------- | ---------------------------- |
| `connectionString` | `REDIS_URL` | `"redis://localhost:6379/0"` |

### Session

| Key              | Env Var                    | Default                    | Description                               |
| ---------------- | -------------------------- | -------------------------- | ----------------------------------------- |
| `ttl`            | `SESSION_TTL`              | `86400` (1 day in seconds) | Session lifetime                          |
| `cookieName`     | `SESSION_COOKIE_NAME`      | `"__session"`              | Cookie name                               |
| `cookieHttpOnly` | `SESSION_COOKIE_HTTP_ONLY` | `true`                     | Prevent JavaScript access                 |
| `cookieSecure`   | `SESSION_COOKIE_SECURE`    | `false`                    | HTTPS-only cookies                        |
| `cookieSameSite` | `SESSION_COOKIE_SAME_SITE` | `"Strict"`                 | CSRF protection (`Strict`, `Lax`, `None`) |

### Process

| Key               | Env Var                    | Default       |
| ----------------- | -------------------------- | ------------- |
| `name`            | `PROCESS_NAME`             | `"server"`    |
| `shutdownTimeout` | `PROCESS_SHUTDOWN_TIMEOUT` | `30000` (30s) |

### Web Server

| Key                    | Env Var                              | Default                                          |
| ---------------------- | ------------------------------------ | ------------------------------------------------ |
| `enabled`              | `WEB_SERVER_ENABLED`                 | `true`                                           |
| `port`                 | `WEB_SERVER_PORT`                    | `8080`                                           |
| `host`                 | `WEB_SERVER_HOST`                    | `"localhost"`                                    |
| `applicationUrl`       | `APPLICATION_URL`                    | `"http://localhost:8080"`                        |
| `apiRoute`             | `WEB_SERVER_API_ROUTE`               | `"/api"`                                         |
| `allowedOrigins`       | `WEB_SERVER_ALLOWED_ORIGINS`         | `"*"`                                            |
| `allowedMethods`       | `WEB_SERVER_ALLOWED_METHODS`         | `"HEAD, GET, POST, PUT, PATCH, DELETE, OPTIONS"` |
| `allowedHeaders`       | `WEB_SERVER_ALLOWED_HEADERS`         | `"Content-Type"`                                 |
| `includeStackInErrors` | `WEB_SERVER_INCLUDE_STACK_IN_ERRORS` | `true` (dev) / `false` (prod)                    |

#### Static Files

| Key                        | Env Var                           | Default                  | Description                         |
| -------------------------- | --------------------------------- | ------------------------ | ----------------------------------- |
| `staticFiles.enabled`      | `WEB_SERVER_STATIC_ENABLED`       | `true`                   | Enable static file serving          |
| `staticFiles.directory`    | `WEB_SERVER_STATIC_DIRECTORY`     | `"assets"`               | Directory to serve files from       |
| `staticFiles.route`        | `WEB_SERVER_STATIC_ROUTE`         | `"/"`                    | URL route prefix for static files   |
| `staticFiles.cacheControl` | `WEB_SERVER_STATIC_CACHE_CONTROL` | `"public, max-age=3600"` | Cache-Control header value          |
| `staticFiles.etag`         | `WEB_SERVER_STATIC_ETAG`          | `true`                   | Enable ETag/304 conditional caching |

#### WebSocket

| Key                              | Env Var                      | Default         | Description                              |
| -------------------------------- | ---------------------------- | --------------- | ---------------------------------------- |
| `websocket.maxPayloadSize`       | `WS_MAX_PAYLOAD_SIZE`        | `65536` (64 KB) | Max message size in bytes                |
| `websocket.maxMessagesPerSecond` | `WS_MAX_MESSAGES_PER_SECOND` | `20`            | Per-connection rate limit                |
| `websocket.maxSubscriptions`     | `WS_MAX_SUBSCRIPTIONS`       | `100`           | Max channel subscriptions per connection |
| `websocket.drainTimeout`         | `WS_DRAIN_TIMEOUT`           | `5000` (5 s)    | Graceful shutdown drain period           |

#### Compression

HTTP responses are automatically compressed when the client sends an `Accept-Encoding` header. Brotli is preferred over gzip. Responses below the threshold or with incompressible content types (images, video, etc.) are served uncompressed.

| Key                     | Env Var                     | Default          | Description                                |
| ----------------------- | --------------------------- | ---------------- | ------------------------------------------ |
| `compression.enabled`   | `WEB_COMPRESSION_ENABLED`   | `true`           | Enable HTTP response compression           |
| `compression.threshold` | `WEB_COMPRESSION_THRESHOLD` | `1024`           | Minimum response size in bytes to compress |
| `compression.encodings` | —                           | `["br", "gzip"]` | Encoding preference order (brotli first)   |

#### Correlation IDs

| Key                        | Env Var                          | Default          | Description                                                   |
| -------------------------- | -------------------------------- | ---------------- | ------------------------------------------------------------- |
| `correlationId.header`     | `WEB_CORRELATION_ID_HEADER`      | `"X-Request-Id"` | Header name to read/echo (empty string to disable)            |
| `correlationId.trustProxy` | `WEB_CORRELATION_ID_TRUST_PROXY` | `false`          | Read and echo the incoming correlation ID header from proxies |

See the [Security guide](/guide/security#correlation-ids) for details.

#### Security Headers

All HTTP responses include these headers. Each is configurable:

| Header                      | Env Var                             | Default                                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `WEB_SECURITY_CSP`                  | `default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: blob:; connect-src 'self'; worker-src blob:` |
| `X-Content-Type-Options`    | `WEB_SECURITY_CONTENT_TYPE_OPTIONS` | `nosniff`                                                                                                                                                                                                                                     |
| `X-Frame-Options`           | `WEB_SECURITY_FRAME_OPTIONS`        | `DENY`                                                                                                                                                                                                                                        |
| `Strict-Transport-Security` | `WEB_SECURITY_HSTS`                 | `max-age=31536000; includeSubDomains`                                                                                                                                                                                                         |
| `Referrer-Policy`           | `WEB_SECURITY_REFERRER_POLICY`      | `strict-origin-when-cross-origin`                                                                                                                                                                                                             |

### Channels

| Key                         | Env Var                       | Default | Description                                       |
| --------------------------- | ----------------------------- | ------- | ------------------------------------------------- |
| `presenceTTL`               | `PRESENCE_TTL`                | `90`    | Presence key TTL in seconds                       |
| `presenceHeartbeatInterval` | `PRESENCE_HEARTBEAT_INTERVAL` | `30`    | Heartbeat interval in seconds to refresh presence |

### Observability

| Key            | Env Var                | Default      | Description                                     |
| -------------- | ---------------------- | ------------ | ----------------------------------------------- |
| `enabled`      | `OTEL_METRICS_ENABLED` | `false`      | Enable OpenTelemetry metrics and /metrics route |
| `metricsRoute` | `OTEL_METRICS_ROUTE`   | `"/metrics"` | URL path for Prometheus scrape endpoint         |
| `serviceName`  | `OTEL_SERVICE_NAME`    | `""`         | Service name in metric labels                   |

### Tasks

| Key                  | Env Var           | Default                   |
| -------------------- | ----------------- | ------------------------- |
| `enabled`            | `TASKS_ENABLED`   | `true`                    |
| `queues`             | —                 | `["*"]`                   |
| `timeout`            | `TASK_TIMEOUT`    | `5000`                    |
| `taskProcessors`     | `TASK_PROCESSORS` | `1` (`0` in test)         |
| `checkTimeout`       | —                 | `500`                     |
| `maxEventLoopDelay`  | —                 | `5`                       |
| `stuckWorkerTimeout` | —                 | `3600000` (1 hour)        |
| `retryStuckJobs`     | —                 | `false`                   |

### Rate Limiting

See the [Security guide](/guide/security) for details on how rate limiting works.

| Key                     | Env Var                               | Default                   |
| ----------------------- | ------------------------------------- | ------------------------- |
| `enabled`               | `RATE_LIMIT_ENABLED`                  | `true` (disabled in test) |
| `windowMs`              | `RATE_LIMIT_WINDOW_MS`                | `60000` (1 min)           |
| `unauthenticatedLimit`  | `RATE_LIMIT_UNAUTH_LIMIT`             | `20`                      |
| `authenticatedLimit`    | `RATE_LIMIT_AUTH_LIMIT`               | `200`                     |
| `keyPrefix`             | `RATE_LIMIT_KEY_PREFIX`               | `"ratelimit"`             |
| `oauthRegisterLimit`    | `RATE_LIMIT_OAUTH_REGISTER_LIMIT`     | `5`                       |
| `oauthRegisterWindowMs` | `RATE_LIMIT_OAUTH_REGISTER_WINDOW_MS` | `3600000` (1 hour)        |

### CLI

| Key                    | Env Var                       | Default |
| ---------------------- | ----------------------------- | ------- |
| `includeStackInErrors` | `CLI_INCLUDE_STACK_IN_ERRORS` | `true`  |
| `quiet`                | `CLI_QUIET`                   | `false` |

### MCP Server

| Key                  | Env Var                    | Default             |
| -------------------- | -------------------------- | ------------------- |
| `enabled`            | `MCP_SERVER_ENABLED`       | `false`             |
| `route`              | `MCP_SERVER_ROUTE`         | `"/mcp"`            |
| `instructions`       | `MCP_SERVER_INSTRUCTIONS`  | package description |
| `oauthClientTtl`     | `MCP_OAUTH_CLIENT_TTL`     | `2592000`           |
| `oauthCodeTtl`       | `MCP_OAUTH_CODE_TTL`       | `300`               |
| `markdownDepthLimit` | `MCP_MARKDOWN_DEPTH_LIMIT` | `5`                 |
