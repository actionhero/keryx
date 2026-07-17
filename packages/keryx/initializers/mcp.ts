import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { api, logger } from "../api";
import { Initializer } from "../classes/Initializer";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import { ansi } from "../util/ansi";
import {
  buildCorsHeaders,
  getExternalOrigin,
  getMcpAllowedOrigins,
  isOriginAllowed,
} from "../util/http";
import { resolveMcpAppUiResources } from "../util/mcpAppBundler";
import {
  adoptMcpSession,
  createMcpServer,
  forgetMcpSession,
  formatToolName,
  handleTransportRequest,
  type McpAuthInfo,
  mcpJsonResponse,
  parseToolName,
  readMcpSessionRecord,
  refreshMcpSessionTtl,
  sanitizeSchemaForMcp,
  terminateMcpSession,
  writeMcpSessionRecord,
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

/**
 * Pull the negotiated `protocolVersion` out of an `initialize` request body
 * (single message or batch) so it can be stored in the shared session registry
 * and replayed when the session is adopted on another node.
 */
function extractInitProtocolVersion(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (isInitializeRequest(message)) {
      const protocolVersion = (
        message as { params?: { protocolVersion?: unknown } }
      ).params?.protocolVersion;
      if (typeof protocolVersion === "string") return protocolVersion;
    }
  }
  return undefined;
}

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
      {
        transport: WebStandardStreamableHTTPServerTransport;
        clientId: string;
      }
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

    // Bundle every MCP App UI (mcp.ui.client) once, before any session can be
    // created, so per-session resource registration serves pre-built HTML and a
    // bundle error fails startup fast.
    await resolveMcpAppUiResources();

    // Build handleRequest — each new session creates a fresh McpServer
    const transports = api.mcp.transports;
    const mcpServers = api.mcp.mcpServers;

    api.mcp.handleRequest = async (
      req: Request,
      ip: string,
    ): Promise<Response> => {
      const method = req.method.toUpperCase();
      const requestOrigin = req.headers.get("origin") ?? undefined;
      const mcpAllowedOrigins = getMcpAllowedOrigins();
      const corsHeaders = buildCorsHeaders(
        requestOrigin,
        {
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          // MCP-Protocol-Version is sent by clients on every request after
          // initialize (spec 2025-06-18+). Browser connectors preflight it, so
          // it must be allow-listed or those requests are silently blocked.
          "Access-Control-Allow-Headers":
            "Content-Type, mcp-session-id, mcp-protocol-version, Authorization",
          "Access-Control-Expose-Headers": "mcp-session-id",
        },
        mcpAllowedOrigins,
      );

      // Reject browser requests from unrecognized origins. Requests with no
      // Origin (non-browser clients like the Claude Code CLI) always pass; the
      // bearer token is the real security boundary for this public endpoint.
      // Uses the same allowlist as buildCorsHeaders above so the 403 gate and
      // the Access-Control-Allow-Origin reflection can never disagree.
      if (requestOrigin && !isOriginAllowed(requestOrigin, mcpAllowedOrigins)) {
        return mcpJsonResponse(
          { error: "Origin not allowed" },
          403,
          corsHeaders,
        );
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
        // Only an `initialize` request may create a new session. Any other
        // request without a session id is a protocol error → 400. We must gate
        // here rather than delegating, otherwise a non-initialize POST spins up
        // an McpServer that never initializes and leaks into `mcpServers`.
        let body: unknown;
        try {
          body = await req.clone().json();
        } catch {
          return mcpJsonResponse({ error: "Invalid JSON" }, 400, corsHeaders);
        }
        const isInit = Array.isArray(body)
          ? body.some(isInitializeRequest)
          : isInitializeRequest(body);
        if (!isInit) {
          return mcpJsonResponse(
            { error: "Mcp-Session-Id header required" },
            400,
            corsHeaders,
          );
        }
        const protocolVersion = extractInitProtocolVersion(body);

        // New session — create a new McpServer + transport
        const mcpServer = createMcpServer();
        mcpServers.push(mcpServer);

        const sessionClientId = authInfo.clientId;
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: async (sid) => {
            // Publish to the shared registry first so any node in the cluster
            // can validate/adopt the session, then register locally + fire
            // onConnect (once, on this originating node only).
            await writeMcpSessionRecord(sid, {
              clientId: sessionClientId,
              protocolVersion,
              createdAt: Date.now(),
            });
            transports.set(sid, { transport, clientId: sessionClientId });
            for (const hook of api.hooks.mcp.onConnectHooks) {
              await hook(sid);
            }
          },
          // Fires on explicit client DELETE: terminate the session cluster-wide.
          onsessionclosed: (sid) => terminateMcpSession(sid, mcpServer),
        });
        // Fires on any close (incl. server shutdown): local cleanup only, so a
        // node bouncing never removes a session other nodes may still serve.
        transport.onclose = () =>
          forgetMcpSession(transport.sessionId, mcpServer);

        await mcpServer.connect(transport);

        for (const hook of api.hooks.mcp.onMessageHooks) {
          await hook(undefined);
        }
        return handleTransportRequest(transport, req, authInfo, corsHeaders);
      }

      if (sessionId) {
        // The shared Redis registry — not the node-local map — is the source of
        // truth for session existence and ownership, so a request that a load
        // balancer routes to any node resolves consistently.
        const record = await readMcpSessionRecord(sessionId);
        if (!record) {
          // Unknown/expired session → 404 (the client's cue to re-`initialize`).
          // Evict any stale local transport so it can never bypass this gate.
          const stale = transports.get(sessionId);
          if (stale) {
            transports.delete(sessionId);
            void stale.transport.close();
          }
          return mcpJsonResponse(
            { error: "Session not found" },
            404,
            corsHeaders,
          );
        }

        if (record.clientId !== authInfo.clientId) {
          return mcpJsonResponse(
            { error: "Token does not match session" },
            403,
            corsHeaders,
          );
        }

        // Use the live local transport, or adopt the session onto this node by
        // re-materializing it from the shared record.
        let transport = transports.get(sessionId)?.transport;
        if (!transport) {
          transport = await adoptMcpSession(
            sessionId,
            record.clientId,
            record.protocolVersion,
          );
        }

        await refreshMcpSessionTtl(sessionId);

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

    // Close all transports
    for (const { transport } of api.mcp.transports.values()) {
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
