---
description: Session-based authentication with middleware, login/signup actions, and OAuth for MCP clients.
---

# Authentication

Keryx uses cookie-based sessions stored in Redis. Authentication is handled through actions and middleware — there's no separate auth plugin or magic. You write a login action, apply `SessionMiddleware` to protected routes, and the framework handles the rest.

## Sessions

When a user logs in, a session is created in Redis and a cookie is set on the response. The session stores arbitrary typed data (like `userId`) and has a configurable TTL (default: 24 hours).

```ts
// Define your session data shape
export type SessionImpl = { userId?: number };
```

The session initializer manages the full lifecycle:

```ts
// Create or update session data
await connection.updateSession({ userId: user.id });

// Regenerate session ID after login (prevents session fixation)
await connection.regenerateSession();

// Access session data
const userId = connection.session?.data.userId;

// Destroy the session (logout)
await api.session.destroy(connection);
```

Sessions are typed via the generic `Connection<T>` parameter, giving you type-safe access to session data throughout your middleware and actions.

## Login Action

A login action validates credentials and creates a session:

```ts
import { SessionMiddleware } from "../middleware/session";
import type { SessionImpl } from "./session";

export class SessionCreate implements Action {
  name = "session:create";
  description = "Sign in with email and password";
  web = { route: "/session", method: HTTP_METHOD.PUT };
  mcp = { tool: false, isLoginAction: true };
  middleware = [RateLimitMiddleware];
  inputs = z.object({
    email: z
      .string()
      .email()
      .transform((val) => val.toLowerCase()),
    password: secret(z.string().min(8)),
  });

  run = async (
    params: ActionParams<SessionCreate>,
    connection: Connection<SessionImpl>,
  ) => {
    const [user] = await api.db.db
      .select()
      .from(users)
      .where(eq(users.email, params.email));

    if (!user || !(await checkPassword(user, params.password))) {
      throw new TypedError({
        message: "Invalid email or password",
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }

    await connection.updateSession({ userId: user.id });
    await connection.regenerateSession();
    return { user: serializeUser(user), session: connection.session! };
  };
}
```

The `mcp = { isLoginAction: true }` marker tells the OAuth system to use this action during the MCP authorization flow. See [MCP](/guide/mcp) for details.

## SessionMiddleware

Apply `SessionMiddleware` to any action that requires authentication:

```ts
import { SessionMiddleware } from "../middleware/session";

export class UserEdit implements Action {
  name = "user:edit";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/user", method: HTTP_METHOD.POST };
  // ...
}
```

If no valid session exists, `SessionMiddleware` throws a `TypedError` with type `CONNECTION_SESSION_NOT_FOUND` (HTTP 401). The action's `run()` method is never called.

The middleware checks both that `connection.session` exists and that `connection.session.data.userId` is set — so even if a session cookie is present, the user must have actually logged in.

## Logout Action

```ts
export class SessionDestroy implements Action {
  name = "session:destroy";
  web = { route: "/session", method: HTTP_METHOD.DELETE };
  middleware = [RateLimitMiddleware, SessionMiddleware];

  async run(_params, connection: Connection<SessionImpl>) {
    await api.session.destroy(connection);
    return { success: true };
  }
}
```

## OAuth for MCP Clients

MCP clients authenticate through OAuth 2.1 with PKCE. The OAuth flow renders a browser-based login/signup page that invokes your login and signup actions. Actions tagged with `mcp.isLoginAction` and `mcp.isSignupAction` must return an `OAuthActionResponse`:

```ts
// Must return this shape from login/signup actions used in OAuth
type OAuthActionResponse = { user: { id: number } };
```

The OAuth page dynamically generates form fields from your action's Zod `inputs` schema — if you change the inputs on your login or signup action, the form updates automatically. Fields wrapped in `secret()` render as password inputs, and `.describe()` text is used for labels.

See the [MCP guide](/guide/mcp#oauth-21-authentication) for the full OAuth flow and endpoint documentation.

## Session Configuration

| Key              | Env Var                    | Default       | Description                               |
| ---------------- | -------------------------- | ------------- | ----------------------------------------- |
| `ttl`            | `SESSION_TTL`              | `86400`       | Session TTL in seconds (1 day)            |
| `cookieName`     | `SESSION_COOKIE_NAME`      | `"__session"` | Cookie name for session tracking          |
| `cookieHttpOnly` | `SESSION_COOKIE_HTTP_ONLY` | `true`        | Prevent JavaScript access                 |
| `cookieSecure`   | `SESSION_COOKIE_SECURE`    | `false`       | HTTPS-only cookies                        |
| `cookieSameSite` | `SESSION_COOKIE_SAME_SITE` | `"Strict"`    | CSRF protection (`Strict`, `Lax`, `None`) |

See the [Security guide](/guide/security) for production recommendations on cookie security settings.

## Testing with Sessions

The pattern for testing authenticated endpoints:

```ts
// 1. Create a user
await fetch(url + "/api/user", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Test User",
    email: "test@example.com",
    password: "password123",
  }),
});

// 2. Log in to get a session
const sessionRes = await fetch(url + "/api/session", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "test@example.com",
    password: "password123",
  }),
});
const { session } = await sessionRes.json();
const sessionId = session.id;

// 3. Use the session cookie on authenticated requests
const res = await fetch(url + "/api/user", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: `${config.session.cookieName}=${sessionId}`,
  },
  body: JSON.stringify({ name: "New Name" }),
});
```

See the [Testing guide](/guide/testing) for more patterns.
