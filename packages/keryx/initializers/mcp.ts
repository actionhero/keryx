import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { api, logger } from "../api";
import { Initializer } from "../classes/Initializer";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import {
  checkRateLimit,
  rateLimitExceededResponse,
} from "../middleware/rateLimit";
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
  buildAnonymousMcpAuthInfo,
  createMcpServer,
  findMcpTargetAction,
  forgetMcpSession,
  formatToolName,
  handleTransportRequest,
  isAnonymousMcpAuth,
  isMcpAccessAllowed,
  isMcpSessionAuthorizedForChannel,
  MCP_JSONRPC_ERROR,
  type McpAuthInfo,
  type McpSessionAuth,
  mcpJsonResponse,
  mcpJsonRpcErrorResponse,
  parseToolName,
  readMcpSessionRecord,
  refreshMcpSessionTtl,
  sanitizeSchemaForMcp,
  terminateMcpSession,
  unlockMcpServer,
  upgradeAnonymousMcpSession,
  validateJsonRpcPayload,
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

/** A live, node-local MCP session: its transport, owning client, and server. */
export type McpTransportEntry = {
  transport: WebStandardStreamableHTTPServerTransport;
  /** OAuth client id that owns the session (the anonymous sentinel if anonymous). */
  clientId: string;
  /** The `McpServer` connected to `transport`. */
  mcpServer: McpServer;
  /**
   * `true` while the server still hides non-public entries from an anonymous
   * session; cleared (via `unlockMcpServer`) once the session upgrades.
   */
  anonymous: boolean;
};

/** Whether a parsed POST body (single message or batch) contains an `initialize` request. */
function containsInitializeRequest(body: unknown): boolean {
  return Array.isArray(body)
    ? body.some(isInitializeRequest)
    : isInitializeRequest(body);
}

/**
 * Build the 401 response that sends an MCP client into the OAuth flow: a
 * `WWW-Authenticate` challenge pointing at the protected resource metadata
 * (RFC 9728). Returned when a token is missing (in `required` mode), invalid or
 * expired (always), or when an anonymous request targets a protected action or
 * an authenticated session (in `optional` mode).
 */
function mcpAuthChallenge(
  req: Request,
  corsHeaders: Record<string, string>,
): Response {
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

/**
 * Rate-limit an anonymous MCP request by IP: every request counts against the
 * unauthenticated limit, and a session-creating `initialize` also counts
 * against the stricter anonymous-session limit.
 *
 * @returns A 429 response if a limit is exceeded, otherwise `undefined`.
 */
async function checkAnonymousMcpRateLimit(
  ip: string,
  isInitialize: boolean,
  corsHeaders: Record<string, string>,
): Promise<Response | undefined> {
  if (!config.rateLimit.enabled) return undefined;
  const keyPrefix = config.rateLimit.keyPrefix;
  const info = await checkRateLimit(`ip:${ip}`, false, {
    keyPrefix: `${keyPrefix}:mcp-anon`,
  });
  if (info.retryAfter !== undefined) {
    return rateLimitExceededResponse(info, corsHeaders);
  }
  if (isInitialize) {
    const initInfo = await checkRateLimit(`ip:${ip}`, false, {
      limit: config.rateLimit.mcpAnonymousInitLimit,
      windowMs: config.rateLimit.mcpAnonymousInitWindowMs,
      keyPrefix: `${keyPrefix}:mcp-anon-init`,
    });
    if (initInfo.retryAfter !== undefined) {
      return rateLimitExceededResponse(initInfo, corsHeaders);
    }
  }
  return undefined;
}

/**
 * Resolve the protocol version an `initialize` request body (single message or
 * batch) actually negotiates, so it can be stored in the shared session registry
 * and replayed when the session is adopted on another node.
 *
 * This is the *negotiated* version, not the requested one: a client on a newer
 * spec revision than the SDK supports (e.g. `2026-07-28`) is answered with the
 * newest version the server does support, exactly as the SDK's `initialize`
 * handler does. Persisting the raw request instead would leave the registry
 * holding a version no node can replay, and the session would silently fall back
 * to the 2025-03-26 default the first time it was adopted elsewhere.
 *
 * @param body - The parsed POST body.
 * @returns The negotiated version, or `undefined` when the body contains no
 * `initialize` request.
 */
function negotiateInitProtocolVersion(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (isInitializeRequest(message)) {
      const protocolVersion = (
        message as { params?: { protocolVersion?: unknown } }
      ).params?.protocolVersion;
      if (typeof protocolVersion !== "string") continue;
      return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
        protocolVersion,
      )
        ? protocolVersion
        : LATEST_PROTOCOL_VERSION;
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
    this.dependsOn = [
      "hooks",
      "actions",
      "oauth",
      "connections",
      "pubsub",
      "channels",
    ];
  }

  async initialize() {
    const mcpServers: McpServer[] = [];
    // Per-session auth context, so a broadcast is delivered only to sessions
    // whose user is authorized for its channel (see sendNotification).
    const mcpServerAuth = new Map<McpServer, McpSessionAuth>();
    const transports = new Map<string, McpTransportEntry>();

    // Deliver a PubSub broadcast to MCP sessions as a logging notification, but
    // ONLY to sessions whose user is authorized to subscribe to the broadcast's
    // channel. Without this gate every session on the node would receive every
    // broadcast — a cross-user/cross-tenant data leak — because MCP sessions
    // have no per-channel subscription of their own. Sessions with no captured
    // auth context are skipped (fail closed).
    async function sendNotification(payload: PubSubMessage) {
      for (const server of mcpServers) {
        const auth = mcpServerAuth.get(server);
        if (!auth) continue;
        const authorized = await isMcpSessionAuthorizedForChannel(
          auth,
          payload.channel,
        );
        if (!authorized) continue;
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
      mcpServerAuth,
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

      // Extract and verify the Bearer token. A token that is present but
      // invalid or expired is always rejected with 401 (the spec requires it),
      // never downgraded to anonymous access.
      let authInfo: McpAuthInfo | undefined;
      const authHeader = req.headers.get("authorization");
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        const tokenData = await api.oauth.verifyAccessToken(token);
        if (!tokenData) return mcpAuthChallenge(req, corsHeaders);
        authInfo = {
          token,
          clientId: tokenData.clientId,
          scopes: tokenData.scopes ?? [],
          extra: { userId: tokenData.userId, ip },
        };
      } else if (config.server.mcp.authMode === "optional") {
        // No token, but anonymous access is enabled: serve the request as an
        // anonymous session limited to `mcp.public` actions.
        authInfo = buildAnonymousMcpAuthInfo(ip);
      } else {
        // Require authentication — return 401 so MCP clients initiate the OAuth flow
        return mcpAuthChallenge(req, corsHeaders);
      }
      const isAnonymous = isAnonymousMcpAuth(authInfo);

      const sessionId = req.headers.get("mcp-session-id");

      // Validate the JSON-RPC envelope of every POST before it reaches a
      // transport. The SDK transport answers both "not JSON" and "not a
      // JSON-RPC message" with `-32700 Parse error`; JSON-RPC 2.0 reserves that
      // code for unparseable input and requires `-32600 Invalid Request` for a
      // payload that parses but isn't a valid message. Parsing here also means
      // the body is read exactly once — the result is handed to the transport as
      // `parsedBody`.
      let body: unknown;
      if (method === "POST") {
        try {
          body = await req.json();
        } catch {
          return mcpJsonRpcErrorResponse(
            MCP_JSONRPC_ERROR.PARSE_ERROR,
            "Parse error: body is not valid JSON",
            400,
            corsHeaders,
          );
        }
        const invalid = validateJsonRpcPayload(body);
        if (invalid) {
          return mcpJsonRpcErrorResponse(
            invalid.code,
            invalid.message,
            400,
            corsHeaders,
          );
        }
      }

      if (isAnonymous) {
        const limited = await checkAnonymousMcpRateLimit(
          ip,
          method === "POST" && !sessionId && containsInitializeRequest(body),
          corsHeaders,
        );
        if (limited) return limited;

        // Step-up: an anonymous call to a protected tool, prompt, or resource
        // gets a 401 challenge before dispatch, so the client runs the OAuth
        // flow and retries with a token (which upgrades the session below).
        if (method === "POST") {
          const messages = Array.isArray(body) ? body : [body];
          const needsAuth = messages.some((message) => {
            const action = findMcpTargetAction(message);
            return (
              action !== undefined && !isMcpAccessAllowed(action, authInfo)
            );
          });
          if (needsAuth) return mcpAuthChallenge(req, corsHeaders);
        }
      }

      if (method === "POST" && !sessionId) {
        // Only an `initialize` request may create a new session. Any other
        // request without a session id is a protocol error → 400. We must gate
        // here rather than delegating, otherwise a non-initialize POST spins up
        // an McpServer that never initializes and leaks into `mcpServers`.
        if (!containsInitializeRequest(body)) {
          return mcpJsonResponse(
            { error: "Mcp-Session-Id header required" },
            400,
            corsHeaders,
          );
        }
        const protocolVersion = negotiateInitProtocolVersion(body);

        // New session — create a new McpServer + transport
        const mcpServer = createMcpServer({ anonymous: isAnonymous });
        mcpServers.push(mcpServer);
        // Capture the session's auth context so channel-broadcast delivery can
        // authorize this session (see sendNotification).
        api.mcp.mcpServerAuth.set(mcpServer, {
          clientId: authInfo.clientId,
          userId: authInfo.extra?.userId,
          ip,
        });

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
              ...(isAnonymous ? { anonymous: true } : {}),
            });
            transports.set(sid, {
              transport,
              clientId: sessionClientId,
              mcpServer,
              anonymous: isAnonymous,
            });
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
        return handleTransportRequest(
          transport,
          req,
          authInfo,
          corsHeaders,
          body,
        );
      }

      if (sessionId) {
        // The shared Redis registry — not the node-local map — is the source of
        // truth for session existence and ownership, so a request that a load
        // balancer routes to any node resolves consistently.
        let record = await readMcpSessionRecord(sessionId);
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

        if (record.anonymous && !isAnonymous) {
          // Upgrade: the first request on an anonymous session that carries a
          // valid token rebinds the session to that token's client (with the
          // authenticated TTL). The swap is atomic, so only one client can
          // ever claim a given anonymous session.
          const current = await upgradeAnonymousMcpSession(
            sessionId,
            record,
            authInfo.clientId,
          );
          if (!current) {
            return mcpJsonResponse(
              { error: "Session not found" },
              404,
              corsHeaders,
            );
          }
          record = current;
        }

        if (isAnonymous && !record.anonymous) {
          // Never downgrade an authenticated session to anonymous access.
          return mcpAuthChallenge(req, corsHeaders);
        }
        if (!isAnonymous && record.clientId !== authInfo.clientId) {
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
            { userId: authInfo.extra?.userId, ip },
            record.anonymous === true,
          );
        }

        // The session has been upgraded (here or on another node) but this
        // node's server still hides protected entries: rebind its broadcast
        // auth to the token's user and reveal everything.
        const local = transports.get(sessionId);
        if (local?.anonymous && !record.anonymous) {
          local.anonymous = false;
          local.clientId = record.clientId;
          api.mcp.mcpServerAuth.set(local.mcpServer, {
            clientId: record.clientId,
            userId: authInfo.extra?.userId,
            ip,
          });
          unlockMcpServer(local.mcpServer);
        }

        await refreshMcpSessionTtl(sessionId, record.anonymous);

        for (const hook of api.hooks.mcp.onMessageHooks) {
          await hook(sessionId);
        }
        return handleTransportRequest(
          transport,
          req,
          authInfo,
          corsHeaders,
          body,
        );
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
    api.mcp.mcpServerAuth.clear();

    api.mcp.handleRequest = null;
  }
}
