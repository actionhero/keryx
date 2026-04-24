import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "crypto";
import { api, logger } from "../api";
import { Initializer } from "../classes/Initializer";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import { ansi } from "../util/ansi";
import { buildCorsHeaders, getExternalOrigin } from "../util/http";
import {
  createMcpServer,
  formatToolName,
  handleTransportRequest,
  type McpAuthInfo,
  mcpJsonResponse,
  parseToolName,
  sanitizeSchemaForMcp,
} from "../util/mcpServer";
import type { PubSubMessage } from "./pubsub";

type McpHandleRequest = (req: Request, ip: string) => Promise<Response>;

/**
 * Runs when a new MCP session is initialized (after the initialize JSON-RPC
 * handshake). `sessionId` is the server-assigned session id.
 * Register via `api.hooks.mcp.onConnect(...)`.
 */
export type OnMcpConnectHook = (sessionId: string) => Promise<void> | void;

/**
 * Runs for each inbound MCP HTTP request (POST/GET/DELETE to the MCP route),
 * before it's dispatched to the transport. `sessionId` is `undefined` for the
 * very first POST that creates a new session. Register via
 * `api.hooks.mcp.onMessage(...)`.
 */
export type OnMcpMessageHook = (
  sessionId: string | undefined,
) => Promise<void> | void;

/**
 * Runs when an MCP session's transport closes and the session is torn down.
 * Register via `api.hooks.mcp.onDisconnect(...)`.
 */
export type OnMcpDisconnectHook = (sessionId: string) => Promise<void> | void;

const namespace = "mcp";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<McpInitializer["initialize"]>>;
  }
}

export class McpInitializer extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["hooks", "actions", "oauth", "connections", "pubsub"];
  }

  async initialize() {
    const mcpServers: McpServer[] = [];
    const transports = new Map<
      string,
      WebStandardStreamableHTTPServerTransport
    >();

    function sendNotification(payload: PubSubMessage) {
      for (const server of mcpServers) {
        try {
          server.server
            .sendLoggingMessage({
              level: "info",
              data: {
                channel: payload.channel,
                message: payload.message,
                sender: payload.sender,
              },
            })
            .catch(() => {
              // transport may be closed
            });
        } catch {
          // transport may be closed
        }
      }
    }

    return {
      mcpServers,
      transports,
      handleRequest: null as McpHandleRequest | null,
      sendNotification,
      formatToolName,
      parseToolName,
      sanitizeSchemaForMcp,
    };
  }

  async start() {
    if (!config.server.mcp.enabled) return;

    const mcpRoute = config.server.mcp.route;

    // Route validation
    if (!mcpRoute.startsWith("/")) {
      throw new TypedError({
        message: `MCP route must start with "/", got: ${mcpRoute}`,
        type: ErrorType.INITIALIZER_VALIDATION,
      });
    }

    const apiRoute = config.server.web.apiRoute;
    if (mcpRoute.startsWith(apiRoute + "/") || mcpRoute === apiRoute) {
      throw new TypedError({
        message: `MCP route "${mcpRoute}" must not be under the API route "${apiRoute}"`,
        type: ErrorType.INITIALIZER_VALIDATION,
      });
    }

    for (const action of api.actions.actions) {
      if (action.web?.route) {
        const fullRoute = apiRoute + action.web.route;
        if (fullRoute === mcpRoute) {
          throw new TypedError({
            message: `MCP route "${mcpRoute}" conflicts with action "${action.name}" route "${fullRoute}"`,
            type: ErrorType.INITIALIZER_VALIDATION,
          });
        }
      }
    }

    // Build handleRequest — each new session creates a fresh McpServer
    const transports = api.mcp.transports;
    const mcpServers = api.mcp.mcpServers;

    api.mcp.handleRequest = async (
      req: Request,
      ip: string,
    ): Promise<Response> => {
      const method = req.method.toUpperCase();
      const requestOrigin = req.headers.get("origin") ?? undefined;
      const corsHeaders = buildCorsHeaders(requestOrigin, {
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, mcp-session-id, Authorization",
        "Access-Control-Expose-Headers": "mcp-session-id",
      });

      // Reject requests from unrecognized origins when APPLICATION_URL is set
      if (requestOrigin) {
        const appUrl = config.server.web.applicationUrl;
        if (appUrl && !appUrl.startsWith("http://localhost")) {
          const allowedOrigin = new URL(appUrl).origin;
          if (requestOrigin !== allowedOrigin) {
            return mcpJsonResponse(
              { error: "Origin not allowed" },
              403,
              corsHeaders,
            );
          }
        }
      }

      // Handle OPTIONS for CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (method !== "GET" && method !== "POST" && method !== "DELETE") {
        return new Response(null, { status: 405, headers: corsHeaders });
      }

      // Extract and verify Bearer token for auth
      let authInfo: McpAuthInfo | undefined;
      const authHeader = req.headers.get("authorization");
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        const tokenData = await api.oauth.verifyAccessToken(token);
        if (tokenData) {
          authInfo = {
            token,
            clientId: tokenData.clientId,
            scopes: tokenData.scopes ?? [],
            extra: { userId: tokenData.userId, ip },
          };
        }
      }

      // Require authentication — return 401 so MCP clients initiate the OAuth flow
      if (!authInfo) {
        const origin = getExternalOrigin(req, new URL(req.url));
        const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource${config.server.mcp.route}`;
        return mcpJsonResponse(
          { error: "Authentication required" },
          401,
          corsHeaders,
          {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp"`,
          },
        );
      }

      const sessionId = req.headers.get("mcp-session-id");

      if (method === "POST" && !sessionId) {
        // New session — create a new McpServer + transport
        const mcpServer = createMcpServer();
        mcpServers.push(mcpServer);

        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: async (sid) => {
            transports.set(sid, transport);
            for (const hook of api.hooks.mcp.onConnectHooks) {
              await hook(sid);
            }
          },
          onsessionclosed: (sid) => {
            transports.delete(sid);
            const idx = mcpServers.indexOf(mcpServer);
            if (idx !== -1) mcpServers.splice(idx, 1);
          },
        });

        transport.onclose = async () => {
          const sid = transport.sessionId;
          if (sid) {
            transports.delete(sid);
            for (const hook of api.hooks.mcp.onDisconnectHooks) {
              await hook(sid);
            }
          }
          const idx = mcpServers.indexOf(mcpServer);
          if (idx !== -1) mcpServers.splice(idx, 1);
        };

        await mcpServer.connect(transport);

        for (const hook of api.hooks.mcp.onMessageHooks) {
          await hook(undefined);
        }
        return handleTransportRequest(transport, req, authInfo, corsHeaders);
      }

      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          return mcpJsonResponse(
            { error: "Session not found" },
            404,
            corsHeaders,
          );
        }

        for (const hook of api.hooks.mcp.onMessageHooks) {
          await hook(sessionId);
        }
        return handleTransportRequest(transport, req, authInfo, corsHeaders);
      }

      // GET/DELETE without session ID
      return mcpJsonResponse(
        { error: "Mcp-Session-Id header required" },
        400,
        corsHeaders,
      );
    };

    const mcpUrl = `${config.server.web.applicationUrl}${mcpRoute}`;
    const startMessage = `started MCP server @ ${mcpUrl}`;
    logger.info(logger.colorize ? ansi.bgBlue(startMessage) : startMessage);
  }

  async stop() {
    if (!config.server.mcp.enabled) return;
    // Guard against partial initialization (e.g. test fixtures where
    // api.start() was aborted mid-way). Without this, stop() crashes on
    // undefined before the other initializers get a chance to clean up.
    if (!api.mcp) return;

    // Close all transports
    for (const transport of api.mcp.transports.values()) {
      try {
        await transport.close();
      } catch {
        // ignore errors during shutdown
      }
    }
    api.mcp.transports.clear();

    // Close all MCP servers
    for (const server of api.mcp.mcpServers) {
      try {
        await server.close();
      } catch {
        // ignore errors during shutdown
      }
    }
    api.mcp.mcpServers.length = 0;

    api.mcp.handleRequest = null;
  }
}
