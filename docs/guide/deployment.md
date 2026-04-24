---
description: Deploying Keryx — Docker, production builds, reverse proxies, and scaling.
---

# Deployment

Keryx is a backend API server. The included Vite + React frontend is a demo app — in production you'll bring your own client. This guide focuses on deploying the backend.

## Production Start

```bash
cd backend

# set NODE_ENV=production in .env, then start
NODE_ENV=production bun start
```

## Docker

There's a `docker-compose.yaml` to run the backend with PostgreSQL and Redis:

```bash
docker compose up
```

You probably won't use this exact setup in production, but it shows how the pieces fit together and gives you a working reference for your own deployment config.

## Environment Variables

Set production config through environment variables. The config system (see [Configuration](/guide/config)) handles the rest:

```bash
NODE_ENV=production
DATABASE_URL=postgres://user:pass@host:5432/dbname
REDIS_URL=redis://host:6379/0
APPLICATION_URL=https://api.example.com
WEB_SERVER_PORT=8080
```

## Production Security

Keryx ships with secure defaults, but a few settings need adjustment for production. See the [Security guide](/guide/security) for full details.

```bash
# Cookies — require HTTPS transport
SESSION_COOKIE_SECURE=true

# CORS — restrict to your domain (wildcard blocks credentials)
WEB_SERVER_ALLOWED_ORIGINS=https://yourapp.com

# Rate limiting — enabled by default, tune thresholds as needed
RATE_LIMIT_UNAUTH_LIMIT=20
RATE_LIMIT_AUTH_LIMIT=200

# Error stack traces — auto-disabled when NODE_ENV=production
NODE_ENV=production

# Security headers — defaults are production-ready
# Customize CSP if your backend serves HTML with external resources:
# WEB_SECURITY_CSP="default-src 'self'; script-src 'self' https://cdn.example.com"

# WebSocket limits — adjust for your expected traffic
# WS_MAX_PAYLOAD_SIZE=65536
# WS_MAX_MESSAGES_PER_SECOND=20
```

## Database Migrations

Migrations auto-apply on server start when `DATABASE_AUTO_MIGRATE=true` (the default). If you'd rather run them explicitly before deploying:

```bash
cd backend && bun run migrations
```

This generates migration files from schema changes into `./drizzle/`. They'll be applied automatically the next time the server starts — or you can set `DATABASE_AUTO_MIGRATE=false` and handle it yourself.

## Reverse Proxy

In production, you'll typically put the backend behind a reverse proxy (nginx, Caddy, etc.) for TLS termination, compression, and load balancing. Here's a minimal nginx config:

```nginx
upstream keryx_backend {
    server 127.0.0.1:8080;
}

server {
    listen 443 ssl;
    server_name api.example.com;

    ssl_certificate /etc/ssl/certs/api.example.com.pem;
    ssl_certificate_key /etc/ssl/private/api.example.com.key;

    location / {
        proxy_pass http://keryx_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Make sure to include the WebSocket upgrade headers — without them, WebSocket connections and MCP Streamable HTTP transport will fail.

## Scaling

Keryx backends can run as multiple instances behind a load balancer. Redis handles the shared state:

- **Sessions** are stored in Redis, so any instance can serve any request
- **PubSub** broadcasts go through Redis, so channel messages reach subscribers on all instances
- **Background tasks** use Resque with Redis, so workers on any instance can process jobs
- **Presence tracking** uses Redis, so `api.channels.members()` returns the global view across all instances

For horizontal scaling, the main consideration is that each instance runs its own Resque workers. Configure `TASK_PROCESSORS` per instance to control how many workers each one runs. Use `["*"]` for queues unless you need dedicated worker instances for specific queues.

## Process Management

In production, use a process manager to keep the backend running:

- **Docker** — use `restart: unless-stopped` in docker-compose
- **systemd** — create a service unit for the backend process
- **PM2** — `pm2 start "bun start" --name keryx-backend`

Keryx handles `SIGINT` and `SIGTERM` for graceful shutdown — it stops accepting new connections, finishes in-flight requests, and disconnects from Redis and Postgres before exiting.

### WebSocket Drain

During shutdown, Keryx sends a close frame with code `1001` (Going Away) and reason `"Server shutting down"` to all connected WebSocket clients before terminating connections. This gives clients an opportunity to reconnect gracefully:

```javascript
ws.onclose = (event) => {
  if (event.code === 1001) {
    // Server shutting down — reconnect after a delay
    setTimeout(() => reconnect(), 5000);
  }
};
```

The drain period is configurable via `WS_DRAIN_TIMEOUT` (default: 5000 ms). After the timeout, any remaining connections are forcibly closed.

## Monitoring & Observability

Keryx includes built-in OpenTelemetry instrumentation. Enable it and point Prometheus at your instances:

```bash
OTEL_METRICS_ENABLED=true bun run start
```

Each Keryx process serves a `/metrics` endpoint in Prometheus exposition format. Add a scrape target to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: "keryx"
    scrape_interval: 15s
    metrics_path: "/metrics"
    static_configs:
      - targets: ["localhost:8080"]
```

Because each process serves its own endpoint, **every node must be scraped individually** — metrics are not aggregated across instances. Use service discovery or list each target explicitly.

For production log aggregation, switch to structured JSON logging:

```bash
LOG_FORMAT=json bun run start
```

This outputs NDJSON with correlated fields (timestamp, level, correlation ID) that can be ingested by Elasticsearch, Datadog, Loki, or any structured log system.

See the [Observability guide](/guide/observability) for the full list of available metrics and custom exporter setup, or the [Tracing plugin](/plugins/tracing) for distributed tracing.
