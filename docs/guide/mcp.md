---
description: MCP server configuration — how actions become tools, controlling tool exposure, McpActionConfig options, response formats, resources, and prompts.
---

# MCP Server

[MCP (Model Context Protocol)](https://modelcontextprotocol.io) is an open standard for connecting AI agents to external tools and data sources. In Keryx, MCP is a natural extension of the transport-agnostic action model — just like an action can serve HTTP, WebSocket, CLI, and background tasks, it can also be exposed as an MCP tool for AI agents.

## Enabling the MCP Server

The MCP server is disabled by default. Enable it with an environment variable:

```bash
MCP_SERVER_ENABLED=true
```

Or set it directly in `backend/config/server/mcp.ts`:

```ts
export const configServerMcp = {
  enabled: true,
  route: "/mcp",
  // ...
};
```

Once enabled, the server listens at `http://localhost:8080/mcp` (or your configured `applicationUrl` + `route`).

## How Actions Become Tools

When the MCP server starts, it registers every action as an MCP tool automatically. No extra configuration needed — if an action exists, it becomes a tool.

For each action:

1. **Name** — The action name is converted to a valid MCP tool name by replacing `:` with `-` (e.g., `user:create` → `user-create`)
2. **Description** — The action's `description` property becomes the tool description
3. **Input schema** — The action's Zod `inputs` schema is converted to JSON Schema for tool parameter definitions

```ts
// This action...
export class UserView implements Action {
  name = "user:view";
  description = "View a user's profile";
  inputs = z.object({ userId: z.string() });
  // ...
}

// ...becomes MCP tool "user-view" with:
// - description: "View a user's profile"
// - inputSchema: { type: "object", properties: { userId: { type: "string" } } }
```

## Controlling Exposure

By default, all actions are exposed as MCP tools. To exclude an action from tool registration:

```ts
export class InternalAction implements Action {
  name = "internal:cleanup";
  mcp = { tool: false };
  // ...
}
```

The full `mcp` property is of type `McpActionConfig`:

| Property         | Type                  | Default | Description                                                                        |
| ---------------- | --------------------- | ------- | ---------------------------------------------------------------------------------- |
| `tool`           | `boolean`             | `true`  | Whether to expose this action as an MCP tool                                       |
| `isLoginAction`  | `boolean`             | —       | Tag as the login action for the OAuth flow                                         |
| `isSignupAction` | `boolean`             | —       | Tag as the signup action for the OAuth flow                                        |
| `resource`       | `object`              | —       | Expose this action as an MCP resource (see [Resources](#resources) below)          |
| `prompt`         | `object`              | —       | Expose this action as an MCP prompt (see [Prompts](#prompts) below)                |
| `ui`             | `McpUiConfig`         | —       | Render the tool's result as an interactive UI (see [MCP Apps](./mcp-apps.md))      |
| `responseFormat` | `MCP_RESPONSE_FORMAT` | `JSON`  | Response format for MCP tool calls (see [Response Format](#response-format) below) |

The `isLoginAction` and `isSignupAction` markers tell the OAuth system which actions to invoke when users authenticate through the MCP authorization page. These actions must return `OAuthActionResponse` (`{ user: { id: number } }`).

## Response Format

By default, MCP tool responses are JSON-serialized. You can configure actions to return human-readable markdown instead, which is more token-efficient for LLM consumers that don't need structured data.

Set `mcp.responseFormat` on an action to change its format:

```ts
import { Action, MCP_RESPONSE_FORMAT } from "keryx";

export class StatusAction implements Action {
  name = "status";
  mcp = { responseFormat: MCP_RESPONSE_FORMAT.MARKDOWN };
  // ...
}
```

### Markdown rendering rules

The automatic markdown serializer converts action return values based on their shape:

| Data shape               | Rendered as             |
| ------------------------ | ----------------------- |
| Flat object              | Bulleted key-value list |
| Nested object            | Headings + recursion    |
| Array of uniform objects | Markdown table          |
| Array of primitives      | Bulleted list           |
| Beyond depth limit       | JSON code block         |

The depth limit controls how many levels of nesting are rendered as markdown before falling back to a JSON code block. Configure it with `MCP_MARKDOWN_DEPTH_LIMIT` (default: `5`).

::: tip
Error responses always use JSON regardless of the requested format, so agents can reliably parse error details programmatically.
:::

## Resources

MCP resources are URI-addressed, read-only data that AI clients can fetch for context. An action becomes an MCP resource by setting `mcp.resource`:

```ts
export class StatusResource implements Action {
  name = "status:resource";
  description = "Server status as an MCP resource";
  mcp = {
    tool: false, // don't also expose as a tool
    resource: { uri: "keryx://status", mimeType: "application/json" },
  };

  async run() {
    return {
      text: JSON.stringify({ ok: true, uptime: api.uptime }),
      mimeType: "application/json",
    };
  }
}
```

The action's `run()` must return either `{ text: string; mimeType?: string }` or `{ blob: string; mimeType?: string }` (base64-encoded binary).

### Resource Templates

Use `uriTemplate` instead of `uri` to expose a parameterized resource. Variables in the template (e.g., `{userId}`) are passed as action params:

```ts
export class UserResource implements Action {
  name = "user:resource";
  description = "Fetch a user by ID as an MCP resource";
  inputs = z.object({ userId: z.string() });
  mcp = {
    tool: false,
    resource: {
      uriTemplate: "keryx://users/{userId}",
      mimeType: "application/json",
    },
  };

  async run(params: ActionParams<UserResource>) {
    const user = await fetchUser(params.userId);
    return { text: JSON.stringify(user), mimeType: "application/json" };
  }
}
```

An action can be registered as both a tool and a resource by omitting `tool: false`.

## Prompts

MCP prompts are named templates that AI clients surface to users (e.g., as slash commands). An action becomes an MCP prompt by setting `mcp.prompt`. The action's `inputs` schema becomes the prompt's argument schema, and `run()` must return `{ description?: string; messages: PromptMessage[] }`:

```ts
export class GreetingPrompt implements Action {
  name = "greeting:prompt";
  description = "A greeting prompt";
  inputs = z.object({ name: z.string().optional() });
  mcp = {
    tool: false,
    prompt: { title: "Greeting" },
  };

  async run(params: ActionParams<GreetingPrompt>) {
    return {
      description: "A personalized greeting",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Hello, ${params.name ?? "world"}!`,
          },
        },
      ],
    };
  }
}
```

## Server Instructions

The MCP server includes an `instructions` string that AI clients display to help users understand what the server provides. By default this is the package description from `package.json`, but you can override it:

```bash
MCP_SERVER_INSTRUCTIONS="This server provides access to the Acme API..."
```

## Schema Sanitization

The MCP SDK's internal JSON Schema converter (`zod/v4-mini`'s `toJSONSchema`) doesn't support all Zod types (e.g., `z.date()`). The MCP initializer tests each field individually and replaces incompatible fields with `z.string()` as a fallback, so your tools always register successfully even if some input types need coercion.

## OAuth 2.1 Authentication

MCP clients authenticate using OAuth 2.1 with PKCE (Proof Key for Code Exchange). The flow is:

1. MCP client connects to `/mcp` and receives a `401` response
2. Client fetches `/.well-known/oauth-protected-resource` to discover the authorization server
3. Client fetches `/.well-known/oauth-authorization-server` for endpoints
4. Client registers dynamically via `POST /oauth/register`
5. Client opens a browser to `/oauth/authorize` with PKCE challenge
6. User logs in or signs up on the authorization page
7. Server issues an authorization code and redirects back
8. Client exchanges the code for an access token at `POST /oauth/token`
9. Client includes `Authorization: Bearer <token>` on subsequent MCP requests

### OAuth Endpoints

| Endpoint                                  | Method | Description                            |
| ----------------------------------------- | ------ | -------------------------------------- |
| `/.well-known/oauth-protected-resource`   | GET    | Resource metadata (RFC 9728)           |
| `/.well-known/oauth-authorization-server` | GET    | Authorization server metadata          |
| `/oauth/register`                         | POST   | Dynamic client registration            |
| `/oauth/authorize`                        | GET    | Authorization page (login/signup form) |
| `/oauth/authorize`                        | POST   | Process login/signup form submission   |
| `/oauth/token`                            | POST   | Exchange authorization code for token  |

### Security

The OAuth implementation includes several hardening measures:

- **Redirect URI validation** — URIs registered via `/oauth/register` must not contain fragments or userinfo. HTTPS is accepted for any host (remote web callbacks); plain `http` is accepted only for loopback addresses (`localhost`, `127.0.0.1`, `[::1]`); and private-use / custom URI schemes (e.g. `vscode://`, `cursor://`) are accepted for native apps per [RFC 8252 §7.1](https://datatracker.ietf.org/doc/html/rfc8252#section-7.1). The `javascript:`, `data:`, `vbscript:`, and `file:` schemes are always rejected. When exchanging authorization codes, the redirect URI must match the registered URI exactly (origin + pathname).
- **Issuer identification (`iss`)** — the authorization response redirect includes an `iss` parameter identifying this authorization server, and `/.well-known/oauth-authorization-server` advertises `authorization_response_iss_parameter_supported: true`. Clients validate `iss` to defend against mix-up attacks ([RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207), MCP 2026-07-28 / SEP-2468).
- **Client `application_type`** — `POST /oauth/register` accepts an `application_type` of `"web"` (the default) or `"native"`, stored on the client record so native/CLI clients are not misclassified as web clients (MCP 2026-07-28 / SEP-837). Any other value is rejected with `invalid_client_metadata`.
- **Registration rate limiting** — `POST /oauth/register` has a separate, stricter rate limit (default: 5 requests per hour per IP) to prevent abuse. See `RATE_LIMIT_OAUTH_REGISTER_LIMIT` and `RATE_LIMIT_OAUTH_REGISTER_WINDOW_MS` in [Configuration](/guide/config).
- **CORS** — OAuth and MCP endpoints respect the `allowedOrigins` configuration. When `allowedOrigins` is `"*"`, credentials headers are not sent, per the browser spec. Set a specific origin in production for credentialed requests to work.
- **Browser MCP clients** — The MCP endpoint admits browser requests whose `Origin` is in `MCP_ALLOWED_ORIGINS` (comma-separated), in addition to `APPLICATION_URL` and `WEB_SERVER_ALLOWED_ORIGINS`. It defaults to the popular browser-based connectors (`https://claude.ai`, `https://claude.com`, `https://chatgpt.com`, `https://vscode.dev`, `https://github.dev`), so web connectors work out of the box even when `WEB_SERVER_ALLOWED_ORIGINS` is locked down. Requests with no `Origin` (CLI and other non-browser clients) always pass — the OAuth bearer token is the security boundary. The origin gate and the `Access-Control-Allow-Origin` response share one allowlist, so they never disagree.

## Session Management

Each authenticated MCP connection creates its own `McpServer` instance. Sessions are tracked via the `mcp-session-id` header — the MCP SDK generates a UUID per session at `initialize` and the client includes it on every subsequent request.

### Cluster-wide sessions (multi-node)

Sessions are recorded in a **shared Redis registry** (`mcp:session:<id>`), so any node in a cluster can serve any session — the same way keryx already scales WebSocket clients using the shared session store and Redis PubSub. When you run more than one keryx process behind a load balancer:

- **Source of truth is Redis, not local memory.** Every request validates the `mcp-session-id` against the registry. The live transport/`McpServer` objects stay node-local (like a WebSocket socket — they can't move), but they're a cache, not the authority.
- **Lazy adoption.** If a request lands on a node that doesn't hold the transport (the load balancer routed it elsewhere), that node re-materializes the session locally from the shared record and serves the request. No sticky-session configuration is required.
- **Idle TTL.** The registry entry has a TTL (`MCP_SESSION_TTL`, default 24h) that is refreshed on every request, so idle sessions are reclaimed automatically.
- **`DELETE` is cluster-wide.** An HTTP `DELETE` to the MCP route removes the shared record, so every node then returns `404` for that session id.
- **The standalone `GET` SSE stream** is held by whichever node the client's `GET` lands on; because PubSub notifications already fan out across the cluster, notifications reach that node regardless of where the session was created.

### Error semantics (per the Streamable HTTP spec)

- **Unknown or expired `mcp-session-id` → `404 Not Found`** (JSON, no SSE stream is opened). This is the client's cue to re-`initialize` and recover automatically — for example after the session's TTL lapses or a `DELETE`.
- **A non-`initialize` `POST` with no `mcp-session-id` → `400 Bad Request`.** Only `initialize` may open a new session.
- **A session id owned by a different OAuth client → `403 Forbidden`.**

### Lifecycle hooks in a cluster

- `onConnect` fires **once**, on the node that runs the real `initialize` handshake. Adopting a session on another node does not re-fire it.
- `onDisconnect` fires **once cluster-wide**, on the node whose `DELETE` (or true teardown) removes the shared record. A node shutting down does **not** fire it — the session may still be live and adoptable elsewhere.
- `onMessage` fires per inbound request, on whichever node handles it.

> **Tip:** sticky sessions (session affinity) are still a useful optimization — they keep a client on the node that already holds its transport and avoid re-adoption — but they are not required for correctness.

## OAuth Templates

The authorization page (login/signup form) is rendered from [Mustache](https://mustache.github.io/) templates in your project's `templates/` directory:

| File                   | Purpose                              |
| ---------------------- | ------------------------------------ |
| `oauth-authorize.html` | Login/signup form with tab switching |
| `oauth-common.css`     | Shared styles for the page           |
| `lion.svg`             | Decorative SVG included in the page  |

These files are scaffolded into your project by `keryx new` and kept in sync by `keryx upgrade`.

### Dynamic Form Fields

Form fields on the login and signup tabs are **generated automatically** from the Zod `inputs` schema of your `isLoginAction` and `isSignupAction` actions. If you add, remove, or rename fields in those actions, the OAuth page updates to match — no template edits required.

The framework uses your schema to determine:

- **Field names** — from the keys of your `z.object({})` shape
- **Labels** — from `.describe()` on each field, or the capitalized field name as a fallback
- **Input types** — fields wrapped in `secret()` render as `type="password"`, fields with "email" in the name render as `type="email"`, everything else is `type="text"`
- **Validation** — `minlength` and `maxlength` attributes are set from Zod `.min()` / `.max()` constraints

### Mustache Variables

The `oauth-authorize.html` template receives these variables:

| Variable       | Type      | Description                                         |
| -------------- | --------- | --------------------------------------------------- |
| `signinFields` | `Array`   | Form field objects for the login action             |
| `signupFields` | `Array`   | Form field objects for the signup action            |
| `hasSignin`    | `boolean` | Whether a login action is configured                |
| `hasSignup`    | `boolean` | Whether a signup action is configured               |
| `errorHtml`    | `string`  | Pre-rendered error message HTML (empty if no error) |
| `hiddenFields` | `string`  | Pre-rendered hidden inputs for OAuth state          |

Each field object in `signinFields` / `signupFields` has: `name`, `label`, `type`, `required`, and optional `minlength` / `maxlength`.

### Customization

To customize the look and feel, edit the template files in your project's `templates/` directory. The Mustache loops and hidden OAuth fields must be preserved for the flow to work — but you can change all styling, layout, and field rendering.

### Shared Theme

For branding, prefer a shared **theme** over cloning the template files. Set [`config.server.web.theme`](./config.md#web-server) to a `.css` file (or a `.ts`/`.js` entrypoint that default-exports a CSS string), and Keryx inlines it into both the OAuth page **and** your [MCP App shells](./mcp-apps.md) — one source of truth for palette and fonts.

The shipped `oauth-common.css` reads from a small set of CSS custom properties, so a theme only needs to redeclare the subset it wants. The theme is inlined **after** `oauth-common.css`, so its `:root` declarations win by cascade order:

```css
/* your theme.css */
:root {
  --keryx-color-primary: #6b46c1;
  --keryx-color-primary-hover: #553c9a;
  --keryx-color-accent: #ec4899;
  --keryx-font-family: "Inter", system-ui, sans-serif;
}
```

| Variable                      | Controls                                              |
| ----------------------------- | ---------------------------------------------------- |
| `--keryx-font-family`         | Page font stack                                      |
| `--keryx-color-primary`       | Headings, buttons, focus rings, active tab, gradient |
| `--keryx-color-primary-hover` | Button hover, gradient midpoint                      |
| `--keryx-color-accent`        | Gradient endpoint                                    |
| `--keryx-bg`                  | Page background (a gradient of the colors above)     |
| `--keryx-surface`             | Card background                                       |
| `--keryx-color-text`          | Form label text                                      |
| `--keryx-color-text-muted`    | Secondary/muted text                                 |
| `--keryx-color-border`        | Input borders                                        |
| `--keryx-radius`              | Card corner radius                                   |

## PubSub Notifications

When messages are broadcast through the PubSub system (e.g., chat messages sent via Redis PubSub), they are forwarded to all connected MCP clients as MCP logging messages. This allows AI agents to receive real-time notifications about events happening in your application.

## Configuration Reference

| Key                  | Env Var                    | Default             | Description                              |
| -------------------- | -------------------------- | ------------------- | ---------------------------------------- |
| `enabled`            | `MCP_SERVER_ENABLED`       | `false`             | Enable the MCP server                    |
| `route`              | `MCP_SERVER_ROUTE`         | `"/mcp"`            | URL path for the MCP endpoint            |
| `allowedOrigins`     | `MCP_ALLOWED_ORIGINS`      | Claude/ChatGPT/VS Code Web | Browser origins allowed to reach the MCP endpoint |
| `instructions`       | `MCP_SERVER_INSTRUCTIONS`  | package description | Instructions shown to MCP clients        |
| `oauthClientTtl`     | `MCP_OAUTH_CLIENT_TTL`     | `2592000`           | OAuth client registration TTL (seconds)  |
| `oauthCodeTtl`       | `MCP_OAUTH_CODE_TTL`       | `300`               | Authorization code TTL (seconds)         |
| `sessionTtl`         | `MCP_SESSION_TTL`          | `86400`             | Shared MCP session registry TTL, refreshed on activity (seconds) |
| `markdownDepthLimit` | `MCP_MARKDOWN_DEPTH_LIMIT` | `5`                 | Max nesting depth for markdown rendering |

## Testing

You can test MCP actions using the `@modelcontextprotocol/sdk` client:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:8080/mcp"),
  {
    requestInit: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  },
);

const client = new Client({ name: "test-client", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
const result = await client.callTool({
  name: "status",
  arguments: {},
});
```
