# @keryxjs/mcp-app

The browser client for [Keryx](https://keryxjs.com) **MCP Apps** — the interactive
HTML UIs an MCP tool can render inside a host (Claude, Claude Desktop, VS Code Copilot,
…).

On the server you point an action's `mcp.ui.client` at a browser entrypoint; Keryx
bundles it at boot and serves it as the `ui://` resource. This package is what that
entrypoint imports: `mountMcpApp()` wraps `@modelcontextprotocol/ext-apps` and the
connect/hydrate lifecycle so you write only a render function.

```ts
// app/status.ts — bundled into the UI by Keryx
import { mountMcpApp } from "@keryxjs/mcp-app";

type Status = { name: string; uptime: number };

mountMcpApp<Status>({
  name: "Server Status",
  render: (data, root) => {
    root.textContent = `${data.name} — up ${Math.round(data.uptime / 1000)}s`;
  },
  refreshTool: { name: "status" }, // optional: powers refresh() + self-hydrate
});
```

`mountMcpApp` registers the tool-result handler **before** connecting (so the host's
initial data push is never missed) and **self-hydrates** by calling the refresh tool if
that push never arrives — the workaround some hosts require.

## TypeScript

Browser code needs DOM types, which must not leak into your Bun server program. Give your
browser directory its own 2-line tsconfig that extends the base shipped here:

```json
{ "extends": "@keryxjs/mcp-app/tsconfig.mcp-app.json", "include": ["**/*.ts"] }
```

## See also

- [MCP Apps guide](https://keryxjs.com/guide/mcp-apps)
- [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps)
