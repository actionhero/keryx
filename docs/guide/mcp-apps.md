---
description: MCP Apps — render an action's MCP tool result as an interactive HTML UI in the host, with structured data delivered via UIResponse.
---

# MCP Apps (Dynamic UIs)

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) is an extension to the Model Context Protocol that lets a tool return an **interactive HTML UI** instead of just text. The host (Claude, Claude Desktop, VS Code Copilot, and others) renders that UI inline in the conversation, inside a sandboxed iframe. The UI can call back into your server's tools and receive fresh data — a dashboard, form, chart, or viewer that lives right next to the chat.

In Keryx this is a natural extension of the action model. Just as an action already exposes an MCP tool, resource, or prompt, it can declare a UI. You add one `mcp.ui` block and return a [`UIResponse`](#uiresponse) from `run()` — Keryx wires up the rest.

::: tip Prerequisite
MCP Apps build on the MCP server. Enable it first (see [MCP Server](./mcp.md)), then add a UI to any tool action.
:::

## How it works

An MCP App combines two MCP primitives that Keryx registers for you:

1. **A tool** whose description points at a UI via `_meta.ui.resourceUri`.
2. **A `ui://` resource** that serves the app's self-contained HTML.

When the model calls the tool, the host fetches the `ui://` resource, renders the HTML in a sandboxed iframe, and pushes the tool's **`structuredContent`** to the app for rendering. The app can then call any tool on your server to fetch more data — all over a secure `postMessage` channel.

```
Action (mcp.ui + returns UIResponse)
  ├─▶ tool  "status-app"        _meta.ui.resourceUri = "ui://status-app"
  └─▶ resource  "ui://status-app"  →  text/html;profile=mcp-app  (your HTML)

tool call ─▶ UIResponse ─▶ { content: [text], structuredContent: {…} }
                                    │                    │
                             model context          app rendering
```

## Declaring a UI

Add a `ui` block to an action's `mcp` config. The only required field is `html` — a self-contained HTML document for the app.

```ts
import { Action, api, UIResponse } from "keryx";
import { z } from "zod";

export class StatusDashboardApp implements Action {
  name = "status:app";
  description = "Show live server status as an interactive dashboard.";
  inputs = z.object({});
  mcp = {
    ui: {
      html: STATUS_DASHBOARD_HTML, // self-contained HTML string
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

That's it — the tool `status-app` is now linked to a `ui://status-app` resource, and calling it delivers the structured data to the app.

::: info The UI is just a string
Keryx never touches the filesystem for you. `html` is a plain string, so you decide where it comes from — an inline template literal for small UIs, or a file you read yourself:

```ts
const html = await Bun.file(
  new URL("./status-app.html", import.meta.url),
).text();
```

Production apps typically **bundle** their UI (framework + JS + CSS) into a single HTML file — for example with [Vite](https://vitejs.dev/) and [`vite-plugin-singlefile`](https://github.com/richVL/vite-plugin-singlefile) — then read the built file here.
:::

## `UIResponse`

Return a `UIResponse` from `run()` to hand the host two payloads at once:

- **`structuredContent`** — the object your app UI renders. Delivered to the app, **not** added to the model's context.
- **`text`** — a text summary added to the model's context. Defaults to `JSON.stringify(structuredContent)`.

```ts
new UIResponse(structuredContent, { text: "optional model-facing summary" });
// or: UIResponse.from(structuredContent, { text: "…" })
```

Over non-MCP transports (HTTP, WebSocket, CLI) a `UIResponse` serializes to its `structuredContent` via `toJSON()`, so the same action still returns useful JSON everywhere. A `GET` to the action's web route returns the structured object directly.

## The UI side

Inside the HTML, talk to the host with the [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) `App` class (a thin wrapper over the `ui/` `postMessage` protocol):

```ts
import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "Server Status", version: "1.0.0" });

// The host pushes this tool's structuredContent when the app first renders.
app.ontoolresult = (result) => render(result.structuredContent);

// Proactively call any tool on your Keryx server.
async function refresh() {
  const result = await app.callServerTool({ name: "status", arguments: {} });
  render(result.structuredContent);
}

app.connect();
```

Because every Keryx action is already a tool, your app can call any of them with `callServerTool` — no separate API to build.

## `McpUiConfig` options

| Property        | Type       | Default             | Description                                                                 |
| --------------- | ---------- | ------------------- | --------------------------------------------------------------------------- |
| `html`          | `string`   | _(required)_        | Self-contained HTML for the app UI.                                         |
| `resourceUri`   | `string`   | `ui://<tool-name>`  | The `ui://` resource URI the tool links to.                                 |
| `csp`           | `object`   | —                   | External origins the app may reach (see [CSP](#csp-and-permissions)).       |
| `permissions`   | `object`   | —                   | Extra iframe capabilities: `camera`, `microphone`, `geolocation`, `clipboardWrite`. |
| `prefersBorder` | `boolean`  | —                   | Hint the host to render a border/frame around the app.                      |
| `domain`        | `string`   | —                   | Logical grouping/isolation hint for the host.                               |

## CSP and permissions

Apps render under a deny-by-default Content-Security-Policy. Keep the HTML self-contained and no CSP tuning is needed. If your UI loads scripts, styles, or data from external origins, declare them:

```ts
mcp = {
  ui: {
    html,
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

For automated tests, assert the wiring over a normal MCP session: the tool's `_meta.ui.resourceUri` appears in `tools/list`, the `ui://` resource reads back HTML with the `text/html;profile=mcp-app` MIME type, and a `tools/call` returns `structuredContent`. See `example/backend/__tests__/initializers/mcp.test.ts`.

## See also

- [MCP Server](./mcp.md) — enabling MCP, tools, resources, prompts, OAuth
- [MCP Apps specification](https://modelcontextprotocol.io/extensions/apps/overview)
- [ext-apps examples](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples) — starter templates for React, Vue, Svelte, and vanilla JS
