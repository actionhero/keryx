import { Action, type ActionParams, api, HTTP_METHOD } from "keryx";
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
