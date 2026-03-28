---
description: Built-in security features — rate limiting, security headers, cookie hardening, CORS, WebSocket protections, and OAuth validation.
---

# Security

Keryx ships with security defaults that are sensible for development and tightenable for production. Most features are configured via environment variables — no code changes needed to go from development to a hardened production deployment.

## Rate Limiting

Rate limiting uses a sliding window algorithm backed by Redis. It's implemented as action middleware, so you can apply it to specific actions or leave it off entirely.

### Setup

Add `RateLimitMiddleware` to any action:

```ts
import { RateLimitMiddleware } from "keryx";

export class UserCreate implements Action {
  name = "user:create";
  middleware = [RateLimitMiddleware];
  // ...
}
```

The middleware identifies clients by user ID (if authenticated) or IP address (if not), and applies different limits to each:

| Config Key             | Env Var                   | Default       | Description                          |
| ---------------------- | ------------------------- | ------------- | ------------------------------------ |
| `enabled`              | `RATE_LIMIT_ENABLED`      | `true`        | Master toggle (disabled in test)     |
| `windowMs`             | `RATE_LIMIT_WINDOW_MS`    | `60000`       | Sliding window size (ms)             |
| `unauthenticatedLimit` | `RATE_LIMIT_UNAUTH_LIMIT` | `20`          | Max requests per window (no session) |
| `authenticatedLimit`   | `RATE_LIMIT_AUTH_LIMIT`   | `200`         | Max requests per window (logged in)  |
| `keyPrefix`            | `RATE_LIMIT_KEY_PREFIX`   | `"ratelimit"` | Redis key prefix                     |

When a client exceeds the limit, the action returns a `429` with a message indicating how many seconds until the window resets. Rate limit info is also included in response headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`).

### Custom Limits

The `checkRateLimit()` function is exported for use outside of action middleware — for example, the OAuth registration endpoint uses it with a stricter limit:

```ts
import { checkRateLimit } from "keryx";

const info = await checkRateLimit(`oauth-register:${ip}`, false, {
  limit: config.rateLimit.oauthRegisterLimit, // default: 5
  windowMs: config.rateLimit.oauthRegisterWindowMs, // default: 1 hour
});
```

## Security Headers

Every HTTP response includes security headers by default. Each is configurable via environment variable:

| Header                      | Env Var                             | Default                                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `WEB_SECURITY_CSP`                  | `default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: blob:; connect-src 'self'; worker-src blob:` |
| `X-Content-Type-Options`    | `WEB_SECURITY_CONTENT_TYPE_OPTIONS` | `nosniff`                                                                                                                                                                                                                                     |
| `X-Frame-Options`           | `WEB_SECURITY_FRAME_OPTIONS`        | `DENY`                                                                                                                                                                                                                                        |
| `Strict-Transport-Security` | `WEB_SECURITY_HSTS`                 | `max-age=31536000; includeSubDomains`                                                                                                                                                                                                         |
| `Referrer-Policy`           | `WEB_SECURITY_REFERRER_POLICY`      | `strict-origin-when-cross-origin`                                                                                                                                                                                                             |

These defaults are production-ready. The CSP allows loading scripts, styles, and fonts from `cdn.jsdelivr.net` (used by the built-in Swagger UI and OAuth pages). Tighten or adjust via `WEB_SECURITY_CSP` for your needs.

## Cookie Security

Session cookies are configured with security flags:

| Config Key       | Env Var                    | Default    | Description                                  |
| ---------------- | -------------------------- | ---------- | -------------------------------------------- |
| `cookieHttpOnly` | `SESSION_COOKIE_HTTP_ONLY` | `true`     | Prevents JavaScript access to the cookie     |
| `cookieSecure`   | `SESSION_COOKIE_SECURE`    | `false`    | Only send cookie over HTTPS                  |
| `cookieSameSite` | `SESSION_COOKIE_SAME_SITE` | `"Strict"` | CSRF protection (`Strict`, `Lax`, or `None`) |

For production, set `SESSION_COOKIE_SECURE=true` so cookies are only transmitted over HTTPS. The `SameSite=Strict` default prevents CSRF attacks by ensuring cookies aren't sent on cross-origin requests.

## CORS

Cross-origin request handling is configured on the web server:

| Config Key       | Env Var                      | Default                                          |
| ---------------- | ---------------------------- | ------------------------------------------------ |
| `allowedOrigins` | `WEB_SERVER_ALLOWED_ORIGINS` | `"*"`                                            |
| `allowedMethods` | `WEB_SERVER_ALLOWED_METHODS` | `"HEAD, GET, POST, PUT, PATCH, DELETE, OPTIONS"` |
| `allowedHeaders` | `WEB_SERVER_ALLOWED_HEADERS` | `"Content-Type"`                                 |

**Important:** When `allowedOrigins` is `"*"` (the default), the server will not send `Access-Control-Allow-Credentials: true` — this follows the browser spec that forbids wildcard origins with credentials. For production, set `WEB_SERVER_ALLOWED_ORIGINS` to your specific domain(s) so that credentialed requests (cookies, auth headers) work correctly.

## WebSocket Protections

WebSocket connections have several layers of protection:

### Origin Validation

Before upgrading an HTTP connection to WebSocket, the server validates the `Origin` header against `config.server.web.allowedOrigins`. If the origin doesn't match, the upgrade is rejected. This prevents Cross-Site WebSocket Hijacking (CSWSH) attacks.

### Message Limits

| Config Key                       | Env Var                      | Default | Description                        |
| -------------------------------- | ---------------------------- | ------- | ---------------------------------- |
| `websocket.maxPayloadSize`       | `WS_MAX_PAYLOAD_SIZE`        | `65536` | Max message size in bytes (64 KB)  |
| `websocket.maxMessagesPerSecond` | `WS_MAX_MESSAGES_PER_SECOND` | `20`    | Per-connection rate limit          |
| `websocket.maxSubscriptions`     | `WS_MAX_SUBSCRIPTIONS`       | `100`   | Max channel subscriptions per conn |

Messages exceeding the payload size are rejected. Clients sending more than the per-second limit are disconnected. These protect against resource exhaustion from misbehaving or malicious clients.

### Channel Validation

- **Channel names** must match the pattern `/^[a-zA-Z0-9:._-]{1,200}$/` — alphanumeric characters plus `:`, `.`, `_`, `-`, max 200 characters
- **Undefined channels** are rejected — if no registered channel matches the requested name, the subscription is denied with a `CONNECTION_CHANNEL_AUTHORIZATION` error

## OAuth Security

The MCP server's OAuth 2.1 implementation includes several hardening measures:

### Redirect URI Validation

When clients register via `/oauth/register`, redirect URIs are validated:

- Must be a valid URL
- Must not contain a fragment (`#`)
- Must not contain userinfo (username/password in the URL)
- Must use HTTPS for non-localhost URIs

When exchanging authorization codes, the redirect URI must match the registered URI exactly (origin + pathname comparison).

### Registration Rate Limiting

OAuth client registration (`POST /oauth/register`) has a separate, stricter rate limit to prevent abuse:

| Config Key              | Env Var                               | Default   | Description                  |
| ----------------------- | ------------------------------------- | --------- | ---------------------------- |
| `oauthRegisterLimit`    | `RATE_LIMIT_OAUTH_REGISTER_LIMIT`     | `5`       | Max registrations per window |
| `oauthRegisterWindowMs` | `RATE_LIMIT_OAUTH_REGISTER_WINDOW_MS` | `3600000` | Window size (1 hour)         |

## Error Stack Traces

By default, error responses include stack traces in development but omit them in production:

| Config Key | Env Var                              | Default                      |
| ---------- | ------------------------------------ | ---------------------------- |
| Web server | `WEB_SERVER_INCLUDE_STACK_IN_ERRORS` | `true` (dev), `false` (prod) |
| CLI        | `CLI_INCLUDE_STACK_IN_ERRORS`        | `true`                       |

The web server default is based on `NODE_ENV` — when `NODE_ENV=production`, stack traces are automatically hidden from HTTP responses to avoid leaking internal implementation details.

## Correlation IDs

When a reverse proxy or load balancer sets a correlation ID header (e.g. `X-Request-Id`), the server can propagate it through the stack for distributed tracing. Enable this by setting `trustProxy` to `true` — the server will read the configured header from the incoming request and echo it back in the response. If the header is not present on a request, no correlation ID is set.

| Config Key   | Env Var                          | Default          | Description                                                   |
| ------------ | -------------------------------- | ---------------- | ------------------------------------------------------------- |
| `header`     | `WEB_CORRELATION_ID_HEADER`      | `"X-Request-Id"` | Header name to read/echo (empty string to disable)            |
| `trustProxy` | `WEB_CORRELATION_ID_TRUST_PROXY` | `false`          | Read and echo the incoming correlation ID header from proxies |

Correlation IDs appear in action log lines as `[cor:<id>]`:

```
[ACTION:WEB:OK] status (3ms) [GET] 127.0.0.1(http://localhost:8080/api/status) [cor:a1b2c3d4-...] {}
```

For fan-out tasks, you can propagate the parent's correlation ID to child jobs via `correlationId` in the fan-out options:

```ts
const result = await api.actions.fanOut("child:action", inputsArray, "worker", {
  correlationId: connection.correlationId,
});
```

## Static File Path Traversal

Static file serving validates requested paths to prevent directory traversal attacks. Requests containing `..` segments that would escape the configured static files directory are rejected with a `403`.

## Production Checklist

When deploying to production, review these environment variables:

```bash
# Cookie security — require HTTPS
SESSION_COOKIE_SECURE=true

# CORS — restrict to your domain
WEB_SERVER_ALLOWED_ORIGINS=https://yourapp.com

# Rate limiting — tune for your traffic
RATE_LIMIT_ENABLED=true
RATE_LIMIT_UNAUTH_LIMIT=20
RATE_LIMIT_AUTH_LIMIT=200

# Error responses — hide internals
NODE_ENV=production
# (stack traces auto-disabled when NODE_ENV=production)

# Security headers — defaults are good, customize CSP if needed
WEB_SECURITY_CSP="default-src 'self'; script-src 'self'"
```
