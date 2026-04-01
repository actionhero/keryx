import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "crypto";
import * as z4mini from "zod/v4-mini";
import { api, logger } from "../api";
import type { Action } from "../classes/Action";
import { MCP_RESPONSE_FORMAT } from "../classes/Action";
import { Connection } from "../classes/Connection";
import { StreamingResponse } from "../classes/StreamingResponse";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import pkg from "../package.json";
import { appendHeaders } from "../util/http";
import { toMarkdown } from "../util/toMarkdown";

/**
 * Convert a Keryx action name to a valid MCP tool name.
 * MCP tool names only allow: A-Z, a-z, 0-9, underscore (_), dash (-), and dot (.)
 */
export function formatToolName(actionName: string): string {
  return actionName.replace(/:/g, "-");
}

/**
 * Convert an MCP tool name back to the original Keryx action name.
 */
export function parseToolName(toolName: string): string {
  const action = api.actions.actions.find(
    (a: Action) => formatToolName(a.name) === toolName,
  );
  return action ? action.name : toolName;
}

/**
 * Auth info extracted from a Bearer token on an MCP request.
 */
export type McpAuthInfo = {
  token: string;
  clientId: string;
  scopes: string[];
  extra?: Record<string, unknown>;
};

/**
 * Create an authenticated MCP Connection from the auth info attached to an MCP request.
 * Shared by tool, resource, and prompt handlers to avoid duplicating connection setup.
 */
export async function createMcpConnection(extra: {
  authInfo?: McpAuthInfo;
  sessionId?: string;
}): Promise<Connection> {
  const authInfo = extra.authInfo;
  const clientIp = (authInfo?.extra?.ip as string) || "unknown";
  const connection = new Connection(
    "mcp",
    clientIp,
    randomUUID(),
    undefined,
    authInfo?.token,
  );

  if (authInfo?.extra?.userId) {
    await connection.loadSession();
    await connection.updateSession({ userId: authInfo.extra.userId });
  }

  return connection;
}

/**
 * Forward a request to an MCP transport and return the response with CORS headers.
 * Handles the try/catch + error response pattern shared by new-session and existing-session paths.
 */
export async function handleTransportRequest(
  transport: WebStandardStreamableHTTPServerTransport,
  req: Request,
  authInfo: McpAuthInfo | undefined,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const response = await transport.handleRequest(req, { authInfo });
    return appendHeaders(response, corsHeaders);
  } catch (e) {
    logger.error(`MCP transport error: ${e}`);
    return mcpJsonResponse(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      },
      500,
      corsHeaders,
    );
  }
}

/**
 * Build a JSON Response with CORS headers. Reduces boilerplate across
 * the many error/status responses in the MCP request handler.
 */
export function mcpJsonResponse(
  body: unknown,
  status: number,
  corsHeaders: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

/**
 * Create a new McpServer instance with all actions registered as tools, resources, and prompts.
 * Each MCP session gets its own McpServer (the SDK requires 1:1 mapping).
 * Actions with `mcp.tool === false` are excluded from tool registration.
 */
export function createMcpServer(): McpServer {
  const mcpServer = new McpServer(
    { name: pkg.name, version: pkg.version },
    { instructions: config.server.mcp.instructions },
  );

  registerTools(mcpServer);
  registerResources(mcpServer);
  registerPrompts(mcpServer);

  return mcpServer;
}

function registerTools(mcpServer: McpServer) {
  const registered = new Set<string>();
  for (const action of api.actions.actions) {
    if (action.mcp?.tool === false) continue;

    const toolName = formatToolName(action.name);
    if (registered.has(toolName)) continue;
    registered.add(toolName);
    const toolConfig: {
      description?: string;
      inputSchema?: any;
    } = {};

    if (action.description) {
      toolConfig.description = action.description;
    }

    toolConfig.inputSchema = action.inputs
      ? sanitizeSchemaForMcp(action.inputs)
      : z4mini.strictObject({});

    mcpServer.registerTool(
      toolName,
      toolConfig,
      async (args: any, extra: any) => {
        const mcpSessionId = extra.sessionId || "";
        const connection = await createMcpConnection(extra);

        try {
          const params =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};

          const { response, error } = await connection.act(
            action.name,
            params,
            "",
            mcpSessionId,
          );

          if (error) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: error.message,
                    type: error.type,
                  }),
                },
              ],
              isError: true,
            };
          }

          // For streaming responses, consume the stream and accumulate into a single result.
          // Send incremental chunks as MCP logging messages for real-time visibility.
          if (response instanceof StreamingResponse) {
            const reader = response.stream.getReader();
            const decoder = new TextDecoder();
            let accumulated = "";
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                accumulated += chunk;
                try {
                  mcpServer.server.sendLoggingMessage({
                    level: "info",
                    data: chunk,
                  });
                } catch (_e) {
                  // Logging message delivery is best-effort
                }
              }
            } finally {
              response.onClose?.();
            }
            return {
              content: [{ type: "text" as const, text: accumulated }],
            };
          }

          const format = action.mcp?.responseFormat ?? MCP_RESPONSE_FORMAT.JSON;
          const text =
            format === MCP_RESPONSE_FORMAT.MARKDOWN
              ? toMarkdown(response, {
                  maxDepth: config.server.mcp.markdownDepthLimit,
                })
              : JSON.stringify(response);

          return {
            content: [{ type: "text" as const, text }],
          };
        } finally {
          connection.destroy();
        }
      },
    );
  }
}

function registerResources(mcpServer: McpServer) {
  for (const action of api.actions.actions) {
    if (!action.mcp?.resource) continue;
    const { uri, uriTemplate, mimeType } = action.mcp.resource;

    const readCb = async (
      mcpUri: URL,
      variables: Record<string, string | string[]>,
      extra: any,
    ) => {
      const mcpSessionId = extra.sessionId || "";
      const connection = await createMcpConnection(extra);

      try {
        const params: Record<string, unknown> = { ...variables };
        const { response, error } = await connection.act(
          action.name,
          params,
          "",
          mcpSessionId,
        );

        if (error) {
          throw new TypedError({
            message: error.message,
            type: error.type ?? ErrorType.CONNECTION_ACTION_RUN,
          });
        }

        const content = response as {
          text?: string;
          blob?: string;
          mimeType?: string;
        };
        const resolvedMimeType =
          content.mimeType ?? mimeType ?? "application/json";

        return {
          contents: [
            {
              uri: mcpUri.toString(),
              mimeType: resolvedMimeType,
              ...(content.blob
                ? { blob: content.blob }
                : {
                    text:
                      typeof content.text === "string"
                        ? content.text
                        : JSON.stringify(response),
                  }),
            },
          ],
        };
      } finally {
        connection.destroy();
      }
    };

    if (uriTemplate) {
      mcpServer.registerResource(
        formatToolName(action.name),
        new ResourceTemplate(uriTemplate, { list: undefined }),
        { description: action.description, mimeType },
        readCb,
      );
    } else if (uri) {
      mcpServer.registerResource(
        formatToolName(action.name),
        uri,
        { description: action.description, mimeType },
        (mcpUri: URL, extra: any) => readCb(mcpUri, {}, extra),
      );
    }
  }
}

function registerPrompts(mcpServer: McpServer) {
  for (const action of api.actions.actions) {
    if (!action.mcp?.prompt) continue;
    const { title } = action.mcp.prompt;

    mcpServer.registerPrompt(
      formatToolName(action.name),
      {
        title: title ?? action.name,
        description: action.description,
        argsSchema: action.inputs
          ? sanitizeSchemaForMcp(action.inputs)?.shape
          : undefined,
      },
      async (args: any, extra: any) => {
        const mcpSessionId = extra.sessionId || "";
        const connection = await createMcpConnection(extra);

        try {
          const params =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};

          const { response, error } = await connection.act(
            action.name,
            params,
            "",
            mcpSessionId,
          );

          if (error) {
            throw new TypedError({
              message: error.message,
              type: error.type ?? ErrorType.CONNECTION_ACTION_RUN,
            });
          }

          return response as any;
        } finally {
          connection.destroy();
        }
      },
    );
  }
}

/**
 * Sanitize a Zod object schema for MCP tool registration.
 * The MCP SDK's internal JSON Schema converter (zod/v4-mini toJSONSchema)
 * cannot handle certain Zod types like z.date(). This function tests each
 * field individually and replaces incompatible fields with z.string().
 */
export function sanitizeSchemaForMcp(schema: any): any {
  if (!schema || typeof schema !== "object" || !("shape" in schema)) {
    return schema;
  }

  // Empty object schemas should use strictObject to produce
  // { type: "object", additionalProperties: false } per MCP spec
  if (Object.entries(schema.shape as Record<string, any>).length === 0) {
    return z4mini.strictObject({});
  }

  const newShape: Record<string, any> = {};
  let needsSanitization = false;

  for (const [key, fieldSchema] of Object.entries(
    schema.shape as Record<string, any>,
  )) {
    try {
      z4mini.toJSONSchema(z4mini.object({ [key]: fieldSchema }), {
        target: "draft-7",
        io: "input",
      });
      newShape[key] = fieldSchema;
    } catch {
      needsSanitization = true;
      newShape[key] = z4mini.string();
    }
  }

  return needsSanitization ? z4mini.object(newShape) : schema;
}
