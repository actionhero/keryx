import { fileURLToPath } from "node:url";
import { Action, type ActionParams, api, HTTP_METHOD, UIResponse } from "keryx";
import { z } from "zod";
import pkg from "../package.json";
import { checkDependencies } from "./status";

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
 * Self-contained HTML for the Server Status MCP App.
 *
 * Keryx accepts an HTML string and does not prescribe a build system. This example bundles
 * the typed client and `@modelcontextprotocol/ext-apps` into its HTML at module load so the
 * sandbox does not need network access or CSP allowances.
 */
const statusDashboardTemplate = await Bun.file(
  new URL("./status-app.html", import.meta.url),
).text();
const statusClientBuild = await Bun.build({
  entrypoints: [
    fileURLToPath(new URL("../ui/status-app-client.ts", import.meta.url)),
  ],
  target: "browser",
  format: "esm",
  minify: true,
});
if (!statusClientBuild.success || !statusClientBuild.outputs[0]) {
  throw new Error(
    `Could not build status app client: ${statusClientBuild.logs.join("\n")}`,
  );
}
const statusClientScript = await statusClientBuild.outputs[0].text();
const STATUS_DASHBOARD_HTML = statusDashboardTemplate.replace(
  "/* STATUS_APP_CLIENT */",
  () => statusClientScript,
);

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
      prefersBorder: true,
    },
  };
  web = { route: "/status/app", method: HTTP_METHOD.GET };

  async run() {
    const consumedMemoryMB =
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100;
    const { healthy, checks } = await checkDependencies();

    return new UIResponse(
      {
        name: api.process.name,
        pid: api.process.pid,
        version: pkg.version,
        uptime: new Date().getTime() - api.bootTime,
        consumedMemoryMB,
        healthy,
        checks,
      },
      { text: `Server ${api.process.name} is running (v${pkg.version}).` },
    );
  }
}
