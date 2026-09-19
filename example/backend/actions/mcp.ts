import {
  Action,
  type ActionParams,
  api,
  Connection,
  config,
  ErrorType,
  HTTP_METHOD,
  TypedError,
  UIResponse,
} from "keryx";
import { z } from "zod";
import pkg from "../package.json";
import { checkDependencies } from "./status";

const ELICIT_KEY = (id: string) => `mcp:elicit:${id}`;

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
 * An MCP App: a tool that renders live server status as an interactive dashboard.
 *
 * Declaring `mcp.ui` registers a `ui://status-app` HTML resource and links this tool to it.
 * `mcp.ui.client` points at the browser entrypoint Keryx bundles for you — with no `html`,
 * Keryx wraps the bundle in a default self-contained shell (a `<div id="root">` document),
 * so this app needs no HTML file of its own. `run()` returns a {@link UIResponse} so the host
 * delivers `structuredContent` to the app for rendering while still adding a text summary to
 * the model's context.
 */
export class StatusDashboardApp implements Action {
  name = "status:app";
  description =
    "Show live server status (name, PID, version, uptime, memory) as an interactive dashboard.";
  inputs = z.object({});
  mcp = {
    tool: true,
    ui: {
      client: new URL("../mcpApp/status.ts", import.meta.url),
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

/**
 * MCP-only tool: asks the user for a display name via form elicitation.
 * There is no web route — `elicitForm` throws on HTTP, CLI, and other transports.
 */
export class ConfirmDisplayName implements Action {
  name = "user:confirm-display-name";
  description = "Ask the user for a display name, then return it";
  inputs = z.object({});
  mcp = { tool: true };

  async run(_params: ActionParams<ConfirmDisplayName>, connection: Connection) {
    const elicited = await connection.elicitForm({
      message: "What display name should we show other people?",
      schema: z.object({
        displayName: z.string().min(1).max(40).describe("Public display name"),
      }),
    });

    if (elicited.action !== "accept") {
      return { saved: false, reason: elicited.action };
    }

    return { saved: true, displayName: elicited.content.displayName };
  }
}

/**
 * MCP-only tool: send the user to an HTTP page to store an API key.
 * `elicitUrl` only collects consent to open the URL. Completion is a Redis
 * key written by {@link SetApiKeyPage} / {@link SubmitApiKey}.
 */
export class LinkApiKey implements Action {
  name = "secrets:link-api-key";
  description =
    "Send the user to a page to set an API key, then continue. The key never crosses the MCP client.";
  inputs = z.object({});
  mcp = { tool: true };

  async run(
    _params: ActionParams<LinkApiKey>,
    connection: Connection,
    abortSignal?: AbortSignal,
  ) {
    const elicitationId = crypto.randomUUID();
    const url = new URL(
      `${config.server.web.apiRoute}/secrets/api-key`,
      config.server.web.applicationUrl,
    );
    url.searchParams.set("elicitationId", elicitationId);

    const elicited = await connection.elicitUrl({
      message:
        "Open this page to store an API key. It never passes through the MCP client.",
      url,
      elicitationId,
    });
    if (elicited.action !== "accept") {
      return { linked: false, reason: elicited.action };
    }

    while (!abortSignal?.aborted) {
      const raw = await api.redis.redis.get(ELICIT_KEY(elicitationId));
      if (raw) {
        const payload = JSON.parse(raw) as { ok: boolean };
        await connection.completeElicitation(elicitationId);
        return { linked: payload.ok };
      }
      await Bun.sleep(50);
    }

    throw new TypedError({
      message: "Timed out waiting for API key page",
      type: ErrorType.CONNECTION_ACTION_TIMEOUT,
    });
  }
}

/**
 * Out-of-band GET page for URL elicitation. Not an MCP tool.
 */
export class SetApiKeyPage implements Action {
  name = "secrets:set-api-key-page";
  description = "HTML form that stores an API key for an MCP URL elicitation";
  inputs = z.object({
    elicitationId: z.string(),
  });
  mcp = { tool: false };
  web = { route: "/secrets/api-key", method: HTTP_METHOD.GET };

  async run(params: ActionParams<SetApiKeyPage>) {
    const elicitationId = encodeURIComponent(params.elicitationId);
    return new Response(
      `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Store API key</title></head>
  <body>
    <h1>Store API key</h1>
    <p>This value stays on the server. It is not sent back through the MCP client.</p>
    <form method="post" action="${config.server.web.apiRoute}/secrets/api-key">
      <input type="hidden" name="elicitationId" value="${elicitationId}" />
      <label>API key <input name="apiKey" type="password" required /></label>
      <button type="submit">Save</button>
    </form>
  </body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

/**
 * Out-of-band POST that records URL-elicitation completion in Redis.
 */
export class SubmitApiKey implements Action {
  name = "secrets:submit-api-key";
  description = "Record that the user stored an API key for an MCP elicitation";
  inputs = z.object({
    elicitationId: z.string(),
    apiKey: z.string().min(1),
  });
  mcp = { tool: false };
  web = { route: "/secrets/api-key", method: HTTP_METHOD.POST };

  async run(params: ActionParams<SubmitApiKey>) {
    await api.redis.redis.set(
      ELICIT_KEY(params.elicitationId),
      JSON.stringify({ ok: true }),
      "EX",
      300,
    );
    return { ok: true };
  }
}
