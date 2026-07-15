import { Action, type ActionParams, api, HTTP_METHOD, UIResponse } from "keryx";
import { z } from "zod";
import pkg from "../package.json";

/**
 * Exposes server status as an MCP resource at `keryx://status`.
 * Not registered as a tool — use the `status` action tool for that.
 */
export class StatusResource implements Action {
  name = "status:resource";
  description =
    "Server status and runtime information, exposed as an MCP resource.";
  inputs = z.object({});
  mcp = {
    tool: false,
    resource: { uri: "keryx://status", mimeType: "application/json" },
  };
  web = { route: "/status/resource", method: HTTP_METHOD.GET };

  async run() {
    const consumedMemoryMB =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;

    return {
      text: JSON.stringify({
        name: api.process.name,
        pid: api.process.pid,
        version: pkg.version,
        uptime: new Date().getTime() - api.bootTime,
        consumedMemoryMB,
      }),
      mimeType: "application/json",
    };
  }
}

/**
 * Exposes a parameterized greeting as an MCP prompt.
 * Demonstrates how an action's `inputs` become prompt arguments.
 */
export class GreetingPrompt implements Action {
  name = "greeting:prompt";
  description = "A greeting prompt that addresses the user by name.";
  inputs = z.object({
    name: z.string().optional().describe("The name to greet"),
  });
  mcp = {
    tool: false,
    prompt: { title: "Greeting" },
  };
  web = { route: "/greeting/prompt", method: HTTP_METHOD.GET };

  async run(params: ActionParams<GreetingPrompt>) {
    return {
      description: "A personalized greeting",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Hello, ${params.name ?? "world"}! How can I help you today?`,
          },
        },
      ],
    };
  }
}

/**
 * Self-contained HTML for the Server Status MCP App, loaded from a sibling `.html` file.
 *
 * Keryx never reads files for you — a `UIResponse` action just needs an HTML string — so we
 * read it ourselves at module load. Keeping the UI in its own `.html` file gives you real
 * editor support (syntax highlighting, formatting) instead of a giant template literal.
 *
 * `status-app.html` uses the `@modelcontextprotocol/ext-apps` `App` class (loaded from a CDN,
 * hence the `csp.resourceDomains` allowance below) to talk to the host over postMessage.
 * Production apps typically bundle their UI (e.g. Vite + vite-plugin-singlefile) and read the
 * built single-file HTML here instead.
 */
const STATUS_DASHBOARD_HTML = await Bun.file(
  new URL("./status-app.html", import.meta.url),
).text();

/**
 * An MCP App: a tool that renders live server status as an interactive dashboard.
 *
 * Declaring `mcp.ui` registers a `ui://status-app` HTML resource and links this tool to it.
 * `run()` returns a {@link UIResponse} so the host delivers `structuredContent` to the app
 * for rendering while still adding a text summary to the model's context.
 */
export class StatusDashboardApp implements Action {
  name = "status:app";
  description =
    "Show live server status (name, PID, version, uptime, memory) as an interactive dashboard.";
  inputs = z.object({});
  mcp = {
    tool: true,
    ui: {
      html: STATUS_DASHBOARD_HTML,
      // The UI imports the ext-apps App class from a CDN, so allow it in the app's CSP.
      csp: { resourceDomains: ["https://esm.sh"] },
      prefersBorder: true,
    },
  };
  web = { route: "/status/app", method: HTTP_METHOD.GET };

  async run() {
    const consumedMemoryMB =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;

    return new UIResponse(
      {
        name: api.process.name,
        pid: api.process.pid,
        version: pkg.version,
        uptime: new Date().getTime() - api.bootTime,
        consumedMemoryMB,
      },
      { text: `Server ${api.process.name} is running (v${pkg.version}).` },
    );
  }
}
