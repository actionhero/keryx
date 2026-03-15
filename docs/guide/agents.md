---
description: How Keryx makes your API automatically available to AI agents via MCP — zero-config tool registration, OAuth 2.1, and typed errors.
---

# Building for AI Agents

If you're building a backend that AI agents need to call, you've probably looked at the [Model Context Protocol](https://modelcontextprotocol.io) (MCP). It's the open standard that Claude Desktop, VS Code Copilot, Cursor, Windsurf, and other AI clients use to discover and call external tools.

Most frameworks don't support MCP at all. The ones that do require you to build a separate MCP server, duplicate your route handlers as tool definitions, and manage a second auth layer. You end up maintaining two APIs — one for humans, one for agents — with no shared validation or middleware.

Keryx treats MCP as a first-class transport. Every [action](/guide/actions) you write is automatically an MCP tool. Same Zod validation, same [middleware](/guide/middleware), same [authentication](/guide/authentication). No duplication.

## What You Get

- **Zero-config tool registration** — write an action, it's an MCP tool. No separate definitions, no schema mapping.
- **OAuth 2.1 + PKCE built-in** — agents authenticate the same way browser clients do. One auth layer, not two.
- **Dynamic OAuth forms** — login and signup pages are generated from your Zod schemas. Change a field, the form updates.
- **Per-session MCP servers** — each agent connection gets its own isolated `McpServer` instance. No cross-session state leaks.
- **Typed errors** — agents get structured `ErrorType` values, not "500 Internal Server Error." They can distinguish validation failures from auth errors from business logic errors.
- **Real-time notifications** — PubSub events are forwarded to connected agents as MCP logging messages. Agents don't just call tools — they react to events.

## Quick Start

### 1. Create a Keryx Project

```bash
bunx keryx new my-agent-api
cd my-agent-api
cp .env.example .env
bun install
```

### 2. Write an Action

Every action is automatically an MCP tool. Here's a simple one:

```ts
export class WeatherLookup implements Action {
  name = "weather:lookup";
  description = "Look up the current weather for a city";
  inputs = z.object({
    city: z.string().describe("City name"),
    units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  });
  web = { route: "/weather/:city", method: HTTP_METHOD.GET };

  async run(params: ActionParams<WeatherLookup>) {
    const weather = await fetchWeather(params.city, params.units);
    return { temperature: weather.temp, conditions: weather.conditions };
  }
}
```

This single class gives you an HTTP endpoint _and_ an MCP tool called `weather-lookup` with a validated input schema — both from the same code.

### 3. Enable MCP

Add one line to your `.env`:

```bash
MCP_SERVER_ENABLED=true
```

Start the server:

```bash
bun dev
```

### 4. Connect an AI Agent

Add your server to Claude Desktop's MCP configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "my-agent-api": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

The agent can now discover all your actions as tools, authenticate via OAuth, and call them with full type validation.

## Controlling Tool Exposure

By default, every action is exposed as an MCP tool. To hide an action from agents:

```ts
export class InternalCleanup implements Action {
  name = "internal:cleanup";
  mcp = { enabled: false };
  // ...
}
```

This is useful for internal maintenance actions, admin-only operations, or actions that don't make sense as agent tools. The action still works over HTTP, WebSocket, CLI, and as a background task — it's hidden from MCP tool discovery only.

Login and signup actions used in the OAuth flow are typically hidden too:

```ts
export class SessionCreate implements Action {
  name = "session:create";
  mcp = { enabled: false, isLoginAction: true };
  // ...
}
```

See the [MCP reference](/guide/mcp#controlling-exposure) for the full `McpActionConfig` type.

## Designing Actions for Agents

Not every action should be an MCP tool, and the actions you _do_ expose shouldn't just be thin wrappers around your database. Agents work best when tools represent **intentions** — higher-order operations that reflect what a user is trying to accomplish — rather than raw CRUD endpoints that force the agent to orchestrate multi-step workflows on its own.

Consider user onboarding. You could expose three tools — `user-create`, `email-send-welcome`, `workspace-create-default` — and hope the agent calls them in the right order with the right parameters. Or you could expose one:

```ts
export class UserOnboard implements Action {
  name = "user:onboard";
  description = "Create a new user account, send welcome email, and set up default workspace";
  inputs = z.object({
    name: z.string().min(3).describe("Display name"),
    email: z.string().email().describe("Email address (used for login)"),
    password: secret(z.string().min(8).describe("Password")),
    company: z.string().optional().describe("Company name for workspace"),
  });
  web = { route: "/user/onboard", method: HTTP_METHOD.PUT };
  mcp = { tool: true };

  async run(params: ActionParams<UserOnboard>) {
    const user = await UserOps.create(params);
    await EmailOps.sendWelcome(user);
    await WorkspaceOps.createDefault(user, params.company);
    return { user: serializeUser(user) };
  }
}
```

The agent calls `user-onboard` once and three things happen. No multi-step orchestration, no missed steps, no half-created state if the agent loses context midway.

This doesn't mean you can't have fine-grained actions — `user:create` is still useful as an HTTP endpoint or background task. Just set `mcp = { tool: false }` on the low-level actions and expose the higher-order workflow as the tool. You keep full flexibility for your HTTP clients while giving agents the right level of abstraction.

A few principles that hold up in practice:

- **Name tools by intent, not by verb + resource.** `user-onboard` is clearer to an agent than `user-create`. The description matters too — agents read it to decide which tool to call.
- **Bundle related side effects.** If operation A always requires operations B and C, make one tool that does all three. The agent doesn't know your business rules — your server does.
- **Use `.describe()` on every Zod field.** These descriptions become the parameter documentation agents see. "Email address (used for login)" is more useful than just `z.string().email()`.
- **Don't expose internal plumbing.** Admin actions, cleanup jobs, and migration tasks aren't useful to agents. Use `mcp = { tool: false }` liberally.

For a deeper dive on tool design patterns for AI agents — including composition, batching, and context injection — see the [Arcade tool design patterns guide](https://www.arcade.dev/patterns).

## The Agent Auth Experience

When an agent connects to your MCP server, it goes through an OAuth 2.1 flow with PKCE:

1. Agent calls `/mcp` and gets a `401` with a metadata URL
2. Agent discovers your OAuth endpoints automatically
3. Agent registers as a client via `POST /oauth/register`
4. Agent opens a browser window for the user to log in
5. User authenticates on a form **generated from your Zod schemas**
6. Agent receives an access token and uses it for all subsequent tool calls

The key detail: the login and signup forms are built from the `inputs` schemas of your `isLoginAction` and `isSignupAction` actions. Fields wrapped in `secret()` render as password inputs, fields with "email" in the name get `type="email"`, and validation constraints like `min(8)` become HTML `minlength` attributes. Change your action's schema, and the OAuth page updates to match.

Once authenticated, protected actions (those using `SessionMiddleware` or similar) work in MCP context the same way they work over HTTP. The agent's session is loaded automatically.

See the [MCP reference](/guide/mcp#oauth-21-authentication) for the full OAuth flow and endpoint details.

## Testing Agent Interactions

Test your MCP tools using the `@modelcontextprotocol/sdk` client:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:8080/mcp"),
  {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  },
);

const client = new Client({ name: "test-client", version: "1.0.0" });
await client.connect(transport);

// List available tools
const tools = await client.listTools();

// Call a tool
const result = await client.callTool({
  name: "weather-lookup",
  arguments: { city: "Portland", units: "fahrenheit" },
});
```

For authenticated tests, see the [MCP reference testing section](/guide/mcp#testing) for the full OAuth token flow.

## Real-Time Notifications

Agents aren't limited to request-response tool calls. When messages are broadcast through the [PubSub system](/guide/channels) (e.g., chat messages via Redis PubSub), they're forwarded to all connected MCP clients as MCP logging messages.

This enables reactive agent behavior — an agent can monitor a channel and respond when new data arrives, rather than polling.

## What Agents See

When an agent calls `listTools`, it gets a clean list of your actions:

- **Tool names** — action names with `:` replaced by `-` (e.g., `user:create` → `user-create`)
- **Descriptions** — from your action's `description` property
- **Input schemas** — JSON Schema generated from your Zod `inputs`, with field descriptions from `.describe()`
- **Typed errors** — when a tool call fails, the agent receives a structured error with an `ErrorType` (e.g., `CONNECTION_INVALID`, `VALIDATION_ERROR`) instead of a generic failure message

The Zod-to-JSON-Schema conversion handles edge cases automatically. Types that can't be represented in JSON Schema (like `z.date()`) fall back to `z.string()`, so tool registration never fails.

## Next Steps

- [MCP reference](/guide/mcp) — full technical details on the MCP server, OAuth endpoints, templates, and configuration
- [Authentication guide](/guide/authentication) — how sessions and middleware work across all transports
- [Actions guide](/guide/actions) — the core concept behind every MCP tool
