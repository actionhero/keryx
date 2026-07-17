---
description: MCP Apps — render an action's MCP tool result as an interactive HTML UI in the host. Point mcp.ui.client at a browser entrypoint; Keryx bundles it and delivers structured data via UIResponse.
---

# MCP Apps (Dynamic UIs)

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) is an extension to the Model Context Protocol that lets a tool return an **interactive HTML UI** instead of just text. The host (Claude, Claude Desktop, VS Code Copilot, and others) renders that UI inline in the conversation, inside a sandboxed iframe. The UI can call back into your server's tools and receive fresh data — a dashboard, form, chart, or viewer that lives right next to the chat.

In Keryx this is a natural extension of the action model. Just as an action already exposes an MCP tool, resource, or prompt, it can declare a UI. You point `mcp.ui.client` at a browser entrypoint and return a [`UIResponse`](#uiresponse) from `run()` — Keryx bundles the client and wires up the rest.

::: tip Prerequisite
MCP Apps build on the MCP server. Enable it first (see [MCP Server](./mcp.md)), then add a UI to any tool action.
:::

## How it works

An MCP App combines two MCP primitives that Keryx registers for you:

1. **A tool** whose description points at a UI via `_meta.ui.resourceUri`.
2. **A `ui://` resource** that serves the app's self-contained HTML.

At startup Keryx bundles your `mcp.ui.client` entrypoint (with Bun's bundler) and inlines it into a self-contained HTML document. When the model calls the tool, the host fetches the `ui://` resource, renders the HTML in a sandboxed iframe, and pushes the tool's **`structuredContent`** to the app for rendering. The app can then call any tool on your server to fetch more data — all over a secure `postMessage` channel.

```
Action (mcp.ui.client + returns UIResponse)
  ├─▶ tool  "status-app"        _meta.ui.resourceUri = "ui://status-app"
  └─▶ resource  "ui://status-app"  →  text/html;profile=mcp-app  (bundled at boot)

tool call ─▶ UIResponse ─▶ { content: [text], structuredContent: {…} }
                                    │                    │
                             model context          app rendering
```

Keryx advertises the `io.modelcontextprotocol/ui` extension capability during `initialize` (when any action declares `mcp.ui`) so compliant hosts negotiate UI support.

## Declaring a UI

An MCP App is two files: the **action** (server) and the **client** (browser).

### 1. The action

Add a `ui` block to an action's `mcp` config and point `client` at a browser entrypoint. Return a [`UIResponse`](#uiresponse) from `run()`.

```ts
import { Action, api, UIResponse } from "keryx";
import { z } from "zod";

export class StatusDashboardApp implements Action {
  name = "status:app";
  description = "Show live server status as an interactive dashboard.";
  inputs = z.object({});
  mcp = {
    ui: {
      client: new URL("../mcpApp/status.ts", import.meta.url), // Keryx bundles this
      prefersBorder: true,
    },
  };

  async run() {
    return new UIResponse(
      {
        name: api.process.name,
        pid: api.process.pid,
        uptime: new Date().getTime() - api.bootTime,
      },
      { text: `Server ${api.process.name} is running.` },
    );
  }
}
```

That's it — the tool `status-app` is now linked to a `ui://status-app` resource whose HTML embeds your bundled client, and calling it delivers the structured data to the app.

::: info No build step, no CDN
`client` is bundled at boot into one self-contained HTML document, so the sandboxed iframe needs no network access and the default deny-by-default CSP just works. You don't run a bundler, add a build script, or maintain a placeholder HTML file. (Bundling happens in a short-lived child process during startup.)
:::

### 2. The client

Install the browser client package:

```bash
bun add @keryxjs/mcp-app
```

Write your entrypoint against [`mountMcpApp`](#mountmcpapp). It connects to the host, renders the tool's structured data, and keeps it fresh:

```ts
// mcpApp/status.ts
import { mountMcpApp } from "@keryxjs/mcp-app";

type Status = { name: string; pid: number; uptime: number };

mountMcpApp<Status>({
  name: "Server Status",
  render: (data, root) => {
    root.innerHTML = `<h1>${data.name}</h1><p>PID ${data.pid}</p>`;
  },
  refreshTool: { name: "status" }, // optional: powers refresh() + self-hydrate
});
```

`root` defaults to the `#root` element in the shell Keryx generates, so a minimal app needs no HTML of its own. When you want custom markup or CSS, provide your own shell — see [Custom HTML shell](#custom-html-shell).

### TypeScript

Browser code needs DOM types, which must not leak into your Bun server program (they clash with Bun's `WebSocket`). Keep browser files in their own directory with a 2-line tsconfig that extends the base shipped by `@keryxjs/mcp-app`:

```json
// mcpApp/tsconfig.json
{ "extends": "@keryxjs/mcp-app/tsconfig.mcp-app.json", "include": ["**/*.ts"] }
```

Then exclude that directory from your server tsconfig (`"exclude": ["mcpApp"]`) and typecheck it separately (`tsc -p mcpApp`).

## `mountMcpApp`

`mountMcpApp(options)` wraps the [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) `App` and the connect/hydrate lifecycle. It registers the tool-result handler **before** connecting (so the host's initial data push is never missed) and **self-hydrates** by calling the refresh tool if that push never arrives — the workaround some hosts (e.g. Cursor) require.

```ts
const { app, refresh } = await mountMcpApp<Status>({
  name: "Server Status",   // reported to the host (default "MCP App")
  version: "1.0.0",
  render: (data, root) => { /* paint the DOM */ },
  onError: (err) => { /* surface failures (default: swallowed) */ },
  root: "#root",           // element or selector passed to render (default "#root")
  refreshTool: { name: "status" }, // tool for refresh()/self-hydrate
});
```

It returns `{ app, refresh }`: call `refresh()` (e.g. from a button) to re-fetch and re-render; `app` is the underlying `App` for advanced use. Because every Keryx action is already a tool, your app can call any of them — JSON object tool results include `structuredContent` automatically, so apps bind without `JSON.parse`. If you omit `refreshTool`, `mountMcpApp` falls back to the app's own tool when the host advertises it.

## `UIResponse`

Return a `UIResponse` from `run()` to hand the host two payloads at once:

- **`structuredContent`** — the object your app UI renders. Delivered to the app, **not** added to the model's context.
- **`text`** — a text summary added to the model's context. Defaults to `JSON.stringify(structuredContent)`.

```ts
new UIResponse(structuredContent, { text: "optional model-facing summary" });
// or: UIResponse.from(structuredContent, { text: "…" })
```

Over non-MCP transports (HTTP, WebSocket, CLI) a `UIResponse` serializes to its `structuredContent` via `toJSON()`, so the same action still returns useful JSON everywhere. A `GET` to the action's web route returns the structured object directly.

`UIResponse` is generic over the shape of `structuredContent`. When you build one from an object literal, the field types are inferred and flow through to `run()`'s return type — and from there into the generated OpenAPI/MCP response schema, so the app UI has a fully-typed payload to bind against rather than an opaque object.

## `McpUiConfig` options

| Property        | Type              | Default             | Description                                                                 |
| --------------- | ----------------- | ------------------- | --------------------------------------------------------------------------- |
| `client`        | `string \| URL`   | —                   | Browser entrypoint Keryx bundles at boot. Provide `client`, `html`, or both.|
| `html`          | `string`          | _(default shell)_   | Verbatim HTML, or (with `client`) the shell the bundle is inlined into.      |
| `resourceUri`   | `string`          | `ui://<tool-name>`  | The `ui://` resource URI the tool links to.                                 |
| `csp`           | `object`          | —                   | External origins the app may reach (see [CSP](#csp-and-permissions)).       |
| `permissions`   | `object`          | —                   | Extra iframe capabilities: `camera`, `microphone`, `geolocation`, `clipboardWrite`. |
| `prefersBorder` | `boolean`         | —                   | Hint the host to render a border/frame around the app.                      |
| `domain`        | `string`          | —                   | Logical grouping/isolation hint for the host.                              |

At least one of `client` or `html` must be set.

## Custom HTML shell

For custom markup or CSS, pass an HTML shell as `html` alongside `client`. Keryx inlines the bundled client into an empty `<script type="module"></script>` (or a `/* MCP_APP_CLIENT */` placeholder comment, else before `</body>`):

```ts
mcp = {
  ui: {
    client: new URL("../mcpApp/status.ts", import.meta.url),
    html: await Bun.file(new URL("./status-app.html", import.meta.url)).text(),
  },
};
```

Your render function can then target elements in that shell directly instead of the default `#root`.

## Bring your own HTML (escape hatch)

You don't have to use `client` at all. Set only `html` to a fully self-contained string and Keryx serves it verbatim — you inline your own scripts and styles (e.g. a UI you bundle with [Vite](https://vitejs.dev/) and [`vite-plugin-singlefile`](https://github.com/richVL/vite-plugin-singlefile)):

```ts
mcp = { ui: { html: await Bun.file(builtHtmlPath).text() } };
```

## CSP and permissions

Apps render under a deny-by-default Content-Security-Policy. Keep the HTML self-contained (the `client` path does this for you) and no CSP tuning is needed. If your UI loads scripts, styles, or data from external origins, declare them:

```ts
mcp = {
  ui: {
    client: new URL("../mcpApp/status.ts", import.meta.url),
    csp: {
      resourceDomains: ["https://esm.sh"], // load scripts/styles from
      connectDomains: ["https://api.example.com"], // fetch/XHR/WebSocket to
    },
    permissions: { clipboardWrite: {} },
  },
};
```

| CSP field         | Controls                                        |
| ----------------- | ----------------------------------------------- |
| `resourceDomains` | Scripts, styles, images, fonts the app may load |
| `connectDomains`  | Origins the app may `fetch`/XHR/WebSocket to     |
| `frameDomains`    | Origins the app may embed in nested frames      |
| `baseUriDomains`  | Origins allowed in the app's `<base href>`      |

## Testing

To see an app render you need a host that supports MCP Apps. Two easy options:

- **basic-host** — the [ext-apps](https://github.com/modelcontextprotocol/ext-apps) repo ships a local test host. From `examples/basic-host`, point it at your server:

  ```bash
  SERVERS='["http://localhost:8080/mcp"]' npm start
  ```

- **Claude** — expose your local server with a tunnel (e.g. `npx cloudflared tunnel --url http://localhost:8080`) and add it as a [custom connector](https://support.anthropic.com/en/articles/11175166).

For automated tests, assert the wiring over a normal MCP session: the tool's `_meta.ui.resourceUri` appears in `tools/list`, the `ui://` resource reads back HTML with the `text/html;profile=mcp-app` MIME type (and contains your bundled client), and a `tools/call` returns `structuredContent`. See `example/backend/__tests__/initializers/mcp.test.ts`.

::: warning Rendering is up to the host
Whether an app actually renders is controlled entirely by the host. MCP Apps is new, and support varies — some clients gate it behind a server-side flag or have version-specific regressions (e.g. a host may negotiate the `io.modelcontextprotocol/ui` capability and list the `ui://` resource, yet never call `resources/read`, falling back to raw text). If a compliant host like the ext-apps basic-host renders your app but another client doesn't, the gap is on the client side, not in your server.
:::

## See also

- [MCP Server](./mcp.md) — enabling MCP, tools, resources, prompts, OAuth
- [`@keryxjs/mcp-app`](https://www.npmjs.com/package/@keryxjs/mcp-app) — the browser client (`mountMcpApp`)
- [MCP Apps specification](https://modelcontextprotocol.io/extensions/apps/overview)
- [ext-apps examples](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples) — starter templates for React, Vue, Svelte, and vanilla JS
