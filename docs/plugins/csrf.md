---
description: CSRF protection middleware that issues per-session tokens and validates them on state-changing requests.
---

# CSRF

`@keryxjs/csrf` adds opt-in CSRF protection to a Keryx app. It exposes a `GET /csrf-token` endpoint that issues a per-session token, and a `CsrfMiddleware` you attach to any state-changing action you want to protect. Tokens are stored in Redis, keyed by session ID, and remain stable for the configured TTL.

This plugin is the recommended response to [issue #447](https://github.com/actionhero/keryx/issues/447). The framework's default `SameSite=Strict` cookie blocks form-based CSRF for most apps, but breaks down once you relax `SameSite` to `Lax` / `None` (e.g. for OAuth flows) or accept `application/x-www-form-urlencoded` payloads. This plugin closes that gap.

## Installation

```bash
bun add @keryxjs/csrf
```

## Configuration

`csrfPlugin` is a factory — call it with the middleware that should guard `/csrf-token`. Without a session check there, anonymous callers can mint tokens against the framework's auto-created anonymous session, which defeats the protection. Pass whatever session middleware your app uses:

```ts
// config/plugins.ts
import { csrfPlugin } from "@keryxjs/csrf";
import { SessionMiddleware } from "../middleware/session";

export default {
  plugins: [csrfPlugin({ tokenActionMiddleware: [SessionMiddleware] })],
};
```

Other config knobs (all optional):

```ts
// config/csrf.ts
export default {
  csrf: {
    tokenTtl: 3600,                    // seconds; refreshed on each /csrf-token fetch
    paramName: "csrfToken",            // params field the token is read from
    redisKeyPrefix: "csrf:token",      // Redis key prefix
  },
};
```

## Protecting an Action

Attach `CsrfMiddleware` to any action that mutates state. **Declare `csrfToken` in the action's input schema** — Zod's `.object()` strips unknown keys before middleware runs, so without this field the token will be silently dropped and every request will fail validation.

```ts
import { CsrfMiddleware } from "@keryxjs/csrf";
import { type Action, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { SessionMiddleware } from "../middleware/session";

export class MessageCreate implements Action {
  name = "message:create";
  middleware = [SessionMiddleware, CsrfMiddleware];
  web = { route: "/message", method: HTTP_METHOD.PUT };
  inputs = z.object({
    body: z.string().min(1),
    csrfToken: z.string().optional(),
  });
  async run(params: { body: string }) {
    /* ... */
  }
}
```

`CsrfMiddleware` is opt-in per action — only the actions you list it on are checked. There is no global enforcement and no method-based exemption (don't add it to GET actions).

## Fetching a Token (SPA)

Call `GET /api/csrf-token` once on app bootstrap (or whenever you suspect the session has rotated). The token must be sent as a body field (or query string parameter) on state-changing requests — there is no header support.

Cast the response through `ActionResponse<CsrfTokenAction>` so the `token` field is typed at the call site (see [Typed Clients](/guide/typed-clients) for the full pattern):

```ts
import type { ActionResponse } from "keryx";
import type { CsrfTokenAction } from "@keryxjs/csrf";

async function getCsrfToken(): Promise<string> {
  const res = await fetch("/api/csrf-token", { credentials: "include" });
  const body = (await res.json()) as ActionResponse<CsrfTokenAction>;
  return body.token;
}

const csrfToken = await getCsrfToken();

await fetch("/api/message", {
  method: "PUT",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ body: "hello", csrfToken }),
});
```

The same token is returned on subsequent calls until it expires or the session is regenerated.

## Sending the Token from an HTML Form

```html
<form method="POST" action="/api/login">
  <input type="hidden" name="csrfToken" value="{{csrfToken}}" />
  <input name="email" />
  <input name="password" type="password" />
  <button type="submit">Sign in</button>
</form>
```

The middleware reads the token from the action's params (folded together from JSON body, form-encoded body, and query string). If you prefer a query parameter for `GET`-style state changes, append `?csrfToken=...` to the URL.

## What's Validated

`CsrfMiddleware.runBefore`:

1. Skips non-web transports (`task`, `cli`, `mcp`, `websocket`) — those have no cross-site request concept.
2. Requires that a session has been established. Anonymous callers get `403`.
3. Reads the candidate token from `params[config.csrf.paramName]` (default `csrfToken`).
4. Compares it constant-time against the value stored at `csrf:token:${sessionId}` in Redis.
5. Throws `403` on miss / mismatch / expiry.

## Token Lifecycle

- **Issuance** — `GET /csrf-token` looks up the token currently bound to the caller's session. If none exists, a fresh 32-byte URL-safe random token is generated. In both cases, the TTL is refreshed.
- **Stability** — the same token is returned for the same session until it expires. This keeps long-lived tabs and cached forms working.
- **Rotation** — call `connection.regenerateSession()` (e.g. on login) to invalidate the previous token. The new session has no token until the next `/csrf-token` fetch.

## Limitations

- Tokens are bound to the session, so the caller must have a session before fetching one. The framework auto-creates an anonymous session on first request.
- This plugin does not validate the `Origin` header. If you want that as a defense-in-depth measure, layer it in front of the middleware (or open an issue for a follow-up).
