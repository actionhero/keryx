---
title: Developer Portal
description: The Keryx developer portal — API reference, OpenAPI spec, authentication, a live sandbox API, the CLI, and the MCP server. Everything an agent or developer needs to integrate with Keryx.
---

# Developer Portal

Everything you need to build with Keryx — as a developer or as an AI agent. Keryx is an open-source, MIT-licensed TypeScript framework: you install it, define [actions](/guide/actions), and every action is automatically an HTTP endpoint, a WebSocket handler, a CLI command, a background task, and an [MCP](/guide/mcp) tool. There's nothing to sign up for and no API keys to request — the framework and the live demo below are free and self-serve.

## Quickstart

```bash
bunx keryx new my-app
cd my-app
cp .env.example .env
bun install
bun dev
```

Your server boots with a machine-readable OpenAPI document at `/api/swagger`, an MCP endpoint at `/mcp`, and OAuth 2.1 discovery at `/.well-known/oauth-authorization-server`. See the [Getting Started guide](/guide/) for the full walkthrough.

## API Reference

- **OpenAPI specification** — [`/openapi.json`](/openapi.json). A complete OpenAPI 3.1 document for the live demo API, with a unique `operationId`, a description, typed parameters, and typed request/response schemas on every operation. Use it to generate typed clients or drive LLM function-calling.
- **Live spec from the running server** — every Keryx server serves its own OpenAPI document at `GET /api/swagger`. On the demo that is <https://api.demo.keryxjs.com/api/swagger>.
- **Reference docs** — the [Action](/reference/actions), [Initializer](/reference/initializers), [Servers](/reference/servers), and [Configuration](/reference/config) references.

## Live Sandbox API

A public demo server runs the [example chat app](https://github.com/actionhero/keryx/tree/main/example) so you can try the API without deploying anything:

| Resource | URL |
| --- | --- |
| API base | `https://api.demo.keryxjs.com/api` |
| Health check | [`/api/status`](https://api.demo.keryxjs.com/api/status) |
| OpenAPI spec | [`/api/swagger`](https://api.demo.keryxjs.com/api/swagger) |
| MCP endpoint | `https://api.demo.keryxjs.com/mcp` |
| Web UI | <https://www.demo.keryxjs.com> |

Try it:

```bash
# Health check — no auth required
curl -s https://api.demo.keryxjs.com/api/status | jq

# Register a user (self-serve, no API key)
curl -s -X PUT https://api.demo.keryxjs.com/api/user \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com","password":"lovelace123"}' | jq
```

The sandbox database is periodically reset. It is for evaluation only — do not store real data.

## Authentication

Keryx ships two auth paths from one code base:

- **Session cookies** for browser and HTTP clients — call `PUT /api/session` (`session:create`) with an email and password to receive a session cookie.
- **OAuth 2.1 + PKCE** for AI agents connecting over MCP. The authorization server metadata is published at [`/.well-known/oauth-authorization-server`](/.well-known/oauth-authorization-server) and the protected-resource metadata (with `scopes_supported`) at [`/.well-known/oauth-protected-resource`](/.well-known/oauth-protected-resource). Clients register dynamically at `POST /oauth/register` — no manual key issuance. The only scope is `mcp`, which grants least-privilege access to the actions you have opted in as tools.

See the [Authentication guide](/guide/authentication) and the [MCP OAuth reference](/guide/mcp#oauth-21-authentication) for the full flow.

## MCP Server

Keryx is MCP-native: any action becomes a tool with one line (`mcp = { tool: true }`). The demo's MCP manifest is published at [`/.well-known/mcp`](/.well-known/mcp).

```json
{
  "mcpServers": {
    "keryx-demo": {
      "url": "https://api.demo.keryxjs.com/mcp"
    }
  }
}
```

Claude Desktop, Cursor, VS Code Copilot, Windsurf, and any other MCP client can discover and call the exposed actions. The browser client library is published on npm as [`@keryxjs/mcp-app`](https://www.npmjs.com/package/@keryxjs/mcp-app). See [Building for AI Agents](/guide/agents) and the [MCP guide](/guide/mcp).

## CLI

The framework ships an official CLI, published on npm as [`keryx`](https://www.npmjs.com/package/keryx):

```bash
bunx keryx new my-app        # scaffold a project
bunx keryx generate action   # generate an action, initializer, plugin, ...
bunx keryx start             # start the server
```

Every action is also runnable directly from the command line, with flags generated from its Zod schema. See the [CLI guide](/guide/cli).

## Documentation for LLMs

- [`/llms.txt`](/llms.txt) — a table of contents of every page, optimized for LLMs.
- [`/llms-full.txt`](/llms-full.txt) — the complete documentation bundle in one file.
- Append `.md` to any documentation URL for the raw Markdown version (e.g. `/guide/actions.md` or `/reference/config.md`).

## Links

- **Source** — [github.com/actionhero/keryx](https://github.com/actionhero/keryx)
- **npm** — [keryx](https://www.npmjs.com/package/keryx)
- **Issues & support** — [github.com/actionhero/keryx/issues](https://github.com/actionhero/keryx/issues)
- **Contact** — [/contact](/contact)
