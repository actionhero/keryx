import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  JSONRPCMessageSchema,
  ListResourceTemplatesRequestSchema,
  type ServerNotification,
  type ServerRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import * as z4mini from "zod/v4-mini";
import { api, logger } from "../api";
import type { Action, McpUiConfig } from "../classes/Action";
import { MCP_APP_MIME_TYPE, MCP_RESPONSE_FORMAT } from "../classes/Action";
import { CONNECTION_TYPE, Connection } from "../classes/Connection";
import { McpUrlElicitationRequiredError } from "../classes/McpUrlElicitationRequiredError";
import { StreamingResponse } from "../classes/StreamingResponse";
import { ErrorType, TypedError } from "../classes/TypedError";
import { UIResponse } from "../classes/UIResponse";
import { config } from "../config";
import pkg from "../package.json";
import { appendHeaders } from "../util/http";
import { getResolvedMcpAppHtml } from "../util/mcpAppBundler";
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
 * Sentinel OAuth client id recorded for anonymous MCP sessions (served when
 * `config.server.mcp.authMode` is `"optional"` and the request has no bearer
 * token). It can never collide with a real client id: registered clients get a
 * UUID and CIMD clients an `https://` URL.
 */
export const ANONYMOUS_MCP_CLIENT_ID = "keryx:anonymous";

/**
 * Build the auth context for an anonymous MCP request. It is passed to the
 * transport like a verified token's, so the client IP still reaches
 * `Connection.identifier` (and IP-keyed rate limiting inside actions), but it
 * carries no token and is flagged `extra.anonymous` so access checks can deny
 * non-public actions.
 *
 * @param ip - The remote IP of the request.
 */
export function buildAnonymousMcpAuthInfo(ip: string): McpAuthInfo {
  return {
    token: "",
    clientId: ANONYMOUS_MCP_CLIENT_ID,
    scopes: [],
    extra: { ip, anonymous: true },
  };
}

/**
 * Whether an MCP request's auth context is anonymous. A missing auth context
 * counts as anonymous, so every access check fails closed.
 */
export function isAnonymousMcpAuth(authInfo: McpAuthInfo | undefined): boolean {
  return !authInfo || authInfo.extra?.anonymous === true;
}

/** Whether an action opted in to anonymous MCP access via `mcp.public`. */
export function isActionPublicForMcp(action: Action): boolean {
  return action.mcp?.public === true;
}

/**
 * Whether an action is registered as an MCP tool. Tools are opt-in: an action
 * must set `mcp.tool = true`, or declare an MCP App (`mcp.ui`) without opting
 * out.
 */
export function isMcpTool(action: Action): boolean {
  return (
    action.mcp?.tool === true ||
    (action.mcp?.ui != null && action.mcp?.tool !== false)
  );
}

/**
 * Find the action an MCP resource URI is served by: a static `mcp.resource.uri`,
 * a match against an `mcp.resource.uriTemplate`, or an MCP App's `ui://` URI.
 *
 * @param uri - The URI from a `resources/read` request.
 * @returns The matching action, or `undefined` if no action serves the URI.
 */
export function findActionForResourceUri(uri: string): Action | undefined {
  for (const action of api.actions.actions) {
    const resource = action.mcp?.resource;
    if (resource?.uri && resource.uri === uri) return action;
    if (resource?.uriTemplate && !resource.uri) {
      try {
        if (new UriTemplate(resource.uriTemplate).match(uri)) return action;
      } catch {
        // malformed template or URI — not a match
      }
    }
    if (action.mcp?.ui && uiResourceUri(action) === uri) return action;
  }
  return undefined;
}

/**
 * Find the action a single JSON-RPC message would invoke: `tools/call` and
 * `prompts/get` by name, `resources/read` by URI. Used to challenge anonymous
 * requests for protected actions with a 401 before they are dispatched.
 *
 * @param message - One JSON-RPC message from a POST body.
 * @returns The targeted action, or `undefined` for any other message or an
 *   unknown target (the SDK then answers with its own not-found error).
 */
export function findMcpTargetAction(message: unknown): Action | undefined {
  if (!message || typeof message !== "object") return undefined;
  const { method, params } = message as {
    method?: unknown;
    params?: { name?: unknown; uri?: unknown };
  };
  if (method === "tools/call" && typeof params?.name === "string") {
    return api.actions.actions.find(
      (a: Action) => isMcpTool(a) && formatToolName(a.name) === params.name,
    );
  }
  if (method === "prompts/get" && typeof params?.name === "string") {
    return api.actions.actions.find(
      (a: Action) =>
        a.mcp?.prompt != null && formatToolName(a.name) === params.name,
    );
  }
  if (method === "resources/read" && typeof params?.uri === "string") {
    return findActionForResourceUri(params.uri);
  }
  return undefined;
}

/**
 * Whether an MCP request may run an action: authenticated requests always may
 * (the action's own middleware still applies), anonymous requests only when the
 * action is marked `mcp.public`.
 */
export function isMcpAccessAllowed(
  action: Action,
  authInfo: McpAuthInfo | undefined,
): boolean {
  return !isAnonymousMcpAuth(authInfo) || isActionPublicForMcp(action);
}

/** The error raised when an anonymous MCP request targets a non-public action. */
function mcpAuthenticationRequiredError(action: Action): TypedError {
  return new TypedError({
    message: `Authentication required: '${formatToolName(action.name)}' is not available to anonymous MCP clients. Reconnect with an OAuth access token.`,
    type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
  });
}

/**
 * Create an authenticated MCP Connection from the auth info attached to an MCP request.
 * Shared by tool, resource, and prompt handlers to avoid duplicating connection setup.
 */
export async function createMcpConnection(
  extra: {
    authInfo?: McpAuthInfo;
    sessionId?: string;
    signal?: AbortSignal;
  },
  mcpServer?: McpServer,
): Promise<Connection> {
  const authInfo = extra.authInfo;
  const clientIp = (authInfo?.extra?.ip as string) || "unknown";
  const connection = new Connection(
    CONNECTION_TYPE.MCP,
    clientIp,
    randomUUID(),
    undefined,
    // Anonymous requests carry an empty token; leave the session id unset so
    // the connection gets its own throwaway session rather than a shared "".
    isAnonymousMcpAuth(authInfo) ? undefined : authInfo?.token,
  );

  if (authInfo?.extra?.userId) {
    await connection.loadSession();
    await connection.updateSession({ userId: authInfo.extra.userId });
  }

  if (mcpServer && extra.signal) {
    connection.setMcpElicitationContext({
      clientCapabilities: mcpServer.server.getClientCapabilities(),
      requestSignal: extra.signal,
      elicitInput: (params, signal) =>
        mcpServer.server.elicitInput(params, { signal }),
      completeElicitation: (elicitationId) =>
        mcpServer.server.createElicitationCompletionNotifier(elicitationId)(),
    });
  }

  return connection;
}

/**
 * Auth context captured for a live MCP session (`McpServer`), used to authorize
 * which channel broadcasts that session is allowed to receive. Keyed by
 * `McpServer` in `api.mcp.mcpServerAuth`.
 */
export type McpSessionAuth = {
  /** OAuth client id that owns the session. */
  clientId: string;
  /** Authenticated user id from the session's access token, if any. */
  userId?: unknown;
  /** Remote IP captured at session creation (best-effort). */
  ip?: string;
};

/**
 * Decide whether an MCP session's user is allowed to receive broadcasts for a
 * channel. Runs the channel's real subscription authorization
 * ({@link api.channels.authorizeSubscription}) against a throwaway in-memory
 * probe connection so app-defined channel middleware/`authorize()` rules apply
 * exactly as they do for WebSocket subscribers.
 *
 * The probe's session is populated in memory (never persisted to Redis) so this
 * check adds no session writes on the broadcast hot path. Fails closed: returns
 * `false` on any authorization error or unknown channel.
 *
 * @param auth - The session's captured auth context.
 * @param channelName - The channel the broadcast targets.
 * @returns `true` only if the session's user may subscribe to `channelName`.
 */
export async function isMcpSessionAuthorizedForChannel(
  auth: McpSessionAuth,
  channelName: string,
): Promise<boolean> {
  const probe = new Connection(
    CONNECTION_TYPE.MCP,
    auth.ip ?? "unknown",
    randomUUID(),
  );
  probe.session = {
    id: probe.sessionId,
    cookieName: config.session.cookieName,
    createdAt: new Date().getTime(),
    data: auth.userId != null ? { userId: auth.userId } : {},
  };
  probe.sessionLoaded = true;
  try {
    await api.channels.authorizeSubscription(channelName, probe);
    return true;
  } catch {
    return false;
  } finally {
    probe.destroy();
  }
}

/**
 * Forward a request to an MCP transport and return the response with CORS headers.
 * Handles the try/catch + error response pattern shared by new-session and existing-session paths.
 *
 * @param transport - The session's Streamable HTTP transport.
 * @param req - The inbound MCP request.
 * @param authInfo - Verified bearer-token context for the request, if any.
 * @param corsHeaders - CORS headers to append to whatever the transport returns.
 * @param parsedBody - The already-parsed POST body, so the transport doesn't
 * re-read (and re-parse) a stream Keryx has already consumed while validating
 * the JSON-RPC envelope. Omit for GET/DELETE.
 */
export async function handleTransportRequest(
  transport: WebStandardStreamableHTTPServerTransport,
  req: Request,
  authInfo: McpAuthInfo | undefined,
  corsHeaders: Record<string, string>,
  parsedBody?: unknown,
): Promise<Response> {
  try {
    const response = await transport.handleRequest(req, {
      authInfo,
      parsedBody,
    });
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
 * The JSON-RPC 2.0 error codes the MCP endpoint returns for a POST body it
 * refuses to dispatch. `PARSE_ERROR` means the body was not JSON at all;
 * `INVALID_REQUEST` means it was JSON but not a well-formed JSON-RPC message.
 * The distinction matters: the MCP SDK transport reports both as `PARSE_ERROR`,
 * which conformance checkers flag, so Keryx validates the envelope itself
 * before handing the body to the transport.
 */
export const MCP_JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
} as const;

/**
 * Build a JSON-RPC *error response* for a message that could never be
 * dispatched. `id` is always `null`: JSON-RPC 2.0 requires a null id when the
 * request's id can't be determined, and the Streamable HTTP transport spec says
 * the body of a rejected POST may carry an error response with no id.
 *
 * @param code - JSON-RPC error code (see {@link MCP_JSONRPC_ERROR}).
 * @param message - Human-readable explanation, surfaced to the client verbatim.
 * @param status - HTTP status to pair with it (400 for malformed input).
 * @param corsHeaders - CORS headers for the MCP endpoint.
 */
export function mcpJsonRpcErrorResponse(
  code: number,
  message: string,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return mcpJsonResponse(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    status,
    corsHeaders,
  );
}

/**
 * Validate a parsed MCP POST body against the JSON-RPC message schema, so a
 * structurally invalid message is rejected as `-32600 Invalid Request` rather
 * than being mislabeled a parse error by the transport.
 *
 * Accepts a single request, notification, or response — and, for clients still
 * on protocol 2025-03-26, a non-empty array of them. Every element of an array
 * must be well-formed; one bad message rejects the whole POST, matching how the
 * transport dispatches batches.
 *
 * @param body - The already-parsed JSON body of the POST.
 * @returns `undefined` when the body is well-formed, otherwise the JSON-RPC
 * `code`/`message` pair to return with HTTP 400.
 */
export function validateJsonRpcPayload(
  body: unknown,
): { code: number; message: string } | undefined {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) {
    return {
      code: MCP_JSONRPC_ERROR.INVALID_REQUEST,
      message: "Invalid Request: JSON-RPC batch must not be empty",
    };
  }
  for (const message of messages) {
    if (!JSONRPCMessageSchema.safeParse(message).success) {
      return {
        code: MCP_JSONRPC_ERROR.INVALID_REQUEST,
        message:
          "Invalid Request: body must be a JSON-RPC request, notification, or response",
      };
    }
  }
  return undefined;
}

/**
 * A record in the shared (Redis-backed) MCP session registry. This is the
 * cluster-wide source of truth for whether a Streamable HTTP session exists and
 * which OAuth client owns it. The live transport/`McpServer` objects are
 * node-local (like a WebSocket socket) and are re-materialized on demand via
 * {@link adoptMcpSession} when a request lands on a node that doesn't hold them.
 */
export interface McpSessionRecord {
  /** OAuth client id bound to the session; enforced on every request (403 on mismatch). */
  clientId: string;
  /** Protocol version negotiated at `initialize`, replayed when adopting on another node. */
  protocolVersion?: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /**
   * `true` for an anonymous session (opened without a token in `optional` auth
   * mode). Such a session expires after `anonymousSessionTtl`, and may be
   * upgraded once — by the first request carrying a valid token — to a session
   * owned by that token's client.
   */
  anonymous?: boolean;
}

/** The idle TTL (seconds) for a session registry record. */
function mcpSessionTtl(anonymous: boolean | undefined): number {
  return anonymous
    ? config.server.mcp.anonymousSessionTtl
    : config.server.mcp.sessionTtl;
}

/** Redis key for a session registry record. */
export function mcpSessionKey(sessionId: string): string {
  return `mcp:session:${sessionId}`;
}

/**
 * Write (or overwrite) a session registry record with the configured TTL.
 * Called once, on the node that runs the real `initialize` handshake.
 *
 * @param sessionId - The transport session id (`Mcp-Session-Id`).
 * @param record - The record to persist.
 */
export async function writeMcpSessionRecord(
  sessionId: string,
  record: McpSessionRecord,
): Promise<void> {
  await api.redis.redis.set(
    mcpSessionKey(sessionId),
    JSON.stringify(record),
    "EX",
    mcpSessionTtl(record.anonymous),
  );
}

/**
 * Read a session registry record. Returns `null` when the session is unknown or
 * expired — the caller must treat that as a 404 (the client's cue to re-`initialize`).
 *
 * @param sessionId - The transport session id (`Mcp-Session-Id`).
 */
export async function readMcpSessionRecord(
  sessionId: string,
): Promise<McpSessionRecord | null> {
  const raw = await api.redis.redis.get(mcpSessionKey(sessionId));
  return raw ? (JSON.parse(raw) as McpSessionRecord) : null;
}

/**
 * Refresh the TTL on a session registry record. Called on every request so the
 * TTL behaves as an idle timeout across the cluster.
 *
 * @param sessionId - The transport session id (`Mcp-Session-Id`).
 * @param anonymous - Whether the session is anonymous (see
 *   {@link McpSessionRecord.anonymous}), which selects the shorter TTL.
 */
export async function refreshMcpSessionTtl(
  sessionId: string,
  anonymous?: boolean,
): Promise<void> {
  await api.redis.redis.expire(
    mcpSessionKey(sessionId),
    mcpSessionTtl(anonymous),
  );
}

/**
 * Atomically upgrade an anonymous session to one owned by an authenticated
 * OAuth client. A compare-and-set on the stored record (Lua, so it is atomic
 * across the cluster) guarantees only one upgrade can win: if two clients race
 * to claim the same anonymous session, the loser sees the winner's record and
 * gets the normal ownership check (403).
 *
 * @param sessionId - The transport session id (`Mcp-Session-Id`).
 * @param anonymousRecord - The anonymous record as just read from Redis.
 * @param clientId - The OAuth client id of the token presented on this request.
 * @returns The upgraded record, or the record as it now stands if another
 *   request changed it first (`null` if it was deleted meanwhile).
 */
export async function upgradeAnonymousMcpSession(
  sessionId: string,
  anonymousRecord: McpSessionRecord,
  clientId: string,
): Promise<McpSessionRecord | null> {
  const { anonymous: _anonymous, ...rest } = anonymousRecord;
  const upgraded: McpSessionRecord = { ...rest, clientId };
  const swapped = await api.redis.redis.eval(
    `if redis.call("GET", KEYS[1]) == ARGV[1] then
       redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
       return 1
     end
     return 0`,
    1,
    mcpSessionKey(sessionId),
    JSON.stringify(anonymousRecord),
    JSON.stringify(upgraded),
    mcpSessionTtl(false),
  );
  return swapped === 1 ? upgraded : readMcpSessionRecord(sessionId);
}

/**
 * Delete a session registry record.
 *
 * @param sessionId - The transport session id (`Mcp-Session-Id`).
 * @returns The number of keys removed (`1` if this call actually deleted the
 *   record, `0` if it was already gone) — used to fire `onDisconnect` hooks
 *   exactly once across the cluster.
 */
export async function deleteMcpSessionRecord(
  sessionId: string,
): Promise<number> {
  return api.redis.redis.del(mcpSessionKey(sessionId));
}

/**
 * Local teardown of an MCP session: drop the transport and its `McpServer` from
 * this node's in-memory maps. Does NOT touch the shared Redis registry, because
 * this also runs on server shutdown (`transport.close()` → `onclose`), where the
 * session may still be live and adoptable on other nodes.
 *
 * @param sessionId - The transport session id, or `undefined` if never initialized.
 * @param mcpServer - The `McpServer` bound to the closing transport.
 */
export function forgetMcpSession(
  sessionId: string | undefined,
  mcpServer: McpServer,
): void {
  if (sessionId) api.mcp.transports.delete(sessionId);
  const idx = api.mcp.mcpServers.indexOf(mcpServer);
  if (idx !== -1) api.mcp.mcpServers.splice(idx, 1);
  api.mcp.mcpServerAuth.delete(mcpServer);
}

/**
 * Full teardown triggered by an explicit client `DELETE` (`onsessionclosed`):
 * drop local state, delete the shared Redis record (so every node then 404s),
 * and — exactly once across the cluster, gated on the delete actually removing
 * the key — run the `onDisconnect` hooks.
 *
 * @param sessionId - The transport session id being terminated.
 * @param mcpServer - The `McpServer` bound to the closing transport.
 */
export async function terminateMcpSession(
  sessionId: string,
  mcpServer: McpServer,
): Promise<void> {
  forgetMcpSession(sessionId, mcpServer);
  const removed = await deleteMcpSessionRecord(sessionId);
  if (removed === 1) {
    for (const hook of api.hooks.mcp.onDisconnectHooks) {
      await hook(sessionId);
    }
  }
}

/**
 * Drive a synthetic `initialize` request through a freshly-created transport so
 * it enters `{ sessionId, initialized: true }` state without a real client
 * round-trip. The initialize response is discarded; awaiting it guarantees the
 * connected `McpServer` finished its handshake before the caller dispatches the
 * real request. Uses only the SDK's public `handleRequest` API.
 *
 * @param transport - A connected transport whose `sessionIdGenerator` returns the target session id.
 * @param protocolVersion - The version negotiated on the originating node, if known.
 */
async function driveSyntheticInitialize(
  transport: WebStandardStreamableHTTPServerTransport,
  protocolVersion: string | undefined,
): Promise<void> {
  const negotiatedVersion =
    protocolVersion &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)
      ? protocolVersion
      : DEFAULT_NEGOTIATED_PROTOCOL_VERSION;

  const initBody = {
    jsonrpc: "2.0" as const,
    id: `keryx-adopt-${randomUUID()}`,
    method: "initialize",
    params: {
      protocolVersion: negotiatedVersion,
      capabilities: {},
      clientInfo: { name: "keryx-adopt", version: pkg.version },
    },
  };

  // Accept must list both content types and Content-Type must be JSON, or the
  // SDK rejects the POST before it ever inspects the (pre-parsed) body.
  const req = new Request("http://keryx.internal/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
  });

  await transport.handleRequest(req, { parsedBody: initBody });
}

/** In-flight adoptions, keyed by session id, so concurrent requests for the same
 * not-yet-local session share one transport instead of racing to build several. */
const adoptionsInFlight = new Map<
  string,
  Promise<WebStandardStreamableHTTPServerTransport>
>();

/**
 * Re-materialize a session that exists in the shared registry but has no live
 * transport on this node (e.g. a load balancer routed a later request to a
 * different node than the one that ran `initialize`). Creates a fresh
 * `McpServer` + transport bound to `sessionId`, drives a synthetic `initialize`
 * to bring it to initialized state, registers it locally, and returns it ready
 * to serve the real request.
 *
 * Adopted transports intentionally do NOT re-run `onConnect` hooks or re-write
 * the Redis record — those already happened on the originating node. They DO
 * wire teardown so a `DELETE` routed here still terminates the session cluster-wide.
 *
 * @param sessionId - The transport session id to adopt.
 * @param clientId - The OAuth client id that owns the session (from the registry record).
 * @param protocolVersion - The negotiated protocol version from the registry record, if any.
 * @param auth - The adopting request's user id / ip, captured so channel-broadcast
 *   authorization ({@link isMcpSessionAuthorizedForChannel}) works for this session too.
 * @param anonymous - Whether the session is anonymous (see
 *   {@link McpSessionRecord.anonymous}); if so, non-public entries are hidden.
 * @returns The connected, initialized transport (also registered in `api.mcp.transports`).
 */
export async function adoptMcpSession(
  sessionId: string,
  clientId: string,
  protocolVersion: string | undefined,
  auth?: Pick<McpSessionAuth, "userId" | "ip">,
  anonymous = false,
): Promise<WebStandardStreamableHTTPServerTransport> {
  const inFlight = adoptionsInFlight.get(sessionId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const mcpServer = createMcpServer({ anonymous });
    api.mcp.mcpServers.push(mcpServer);
    api.mcp.mcpServerAuth.set(mcpServer, {
      clientId,
      userId: auth?.userId,
      ip: auth?.ip,
    });
    try {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        enableJsonResponse: true,
        // Local registration only — no hooks, no registry write (see doc above).
        onsessioninitialized: (sid) => {
          api.mcp.transports.set(sid, {
            transport,
            clientId,
            mcpServer,
            anonymous,
          });
        },
        onsessionclosed: (sid) => terminateMcpSession(sid, mcpServer),
      });
      transport.onclose = () =>
        forgetMcpSession(transport.sessionId, mcpServer);

      await mcpServer.connect(transport);
      await driveSyntheticInitialize(transport, protocolVersion);
      return transport;
    } catch (e) {
      // Adoption failed partway (e.g. the synthetic initialize errored) — drop
      // the McpServer we optimistically registered so it can't linger in the
      // broadcast list nor leave a half-initialized transport behind.
      forgetMcpSession(sessionId, mcpServer);
      throw e;
    }
  })();

  adoptionsInFlight.set(sessionId, promise);
  try {
    return await promise;
  } finally {
    adoptionsInFlight.delete(sessionId);
  }
}

/**
 * Tools, resources, and prompts registered on an anonymous session's
 * `McpServer` but disabled (hidden from list results) because their action is
 * not `mcp.public`. {@link unlockMcpServer} enables them on session upgrade.
 */
const gatedMcpItems = new WeakMap<McpServer, Array<{ enable(): void }>>();

/**
 * Hide a just-registered tool/resource/prompt from an anonymous session when its
 * action is not `mcp.public`. The item stays registered (the SDK cannot add
 * capabilities after `connect()`), so the session can be unlocked later.
 */
function gateForAnonymous(
  mcpServer: McpServer,
  action: Action,
  item: { enable(): void; disable(): void },
  anonymous: boolean,
): void {
  if (!anonymous || isActionPublicForMcp(action)) return;
  item.disable();
  const gated = gatedMcpItems.get(mcpServer) ?? [];
  gated.push(item);
  gatedMcpItems.set(mcpServer, gated);
}

/**
 * Reveal every tool, resource, and prompt hidden from an anonymous session,
 * after the session upgrades to an authenticated one. The SDK sends the
 * client `notifications/tools/list_changed` (and the resource and prompt
 * equivalents) as each item is enabled. A no-op for servers created for authenticated sessions or already
 * unlocked.
 *
 * @param mcpServer - The session's `McpServer`, created via
 *   `createMcpServer({ anonymous: true })`.
 */
export function unlockMcpServer(mcpServer: McpServer): void {
  const gated = gatedMcpItems.get(mcpServer);
  if (!gated) return;
  gatedMcpItems.delete(mcpServer);
  for (const item of gated) item.enable();
}

/**
 * Create a new McpServer instance with all actions registered as tools, resources, and prompts.
 * Each MCP session gets its own McpServer (the SDK requires 1:1 mapping).
 * Actions with `mcp.tool === false` are excluded from tool registration.
 *
 * @param options.anonymous - Build the server for an anonymous session
 *   (`MCP_AUTH_MODE=optional`, no token): everything whose action is not
 *   `mcp.public` is registered but disabled, so list results show only public
 *   entries until {@link unlockMcpServer} is called on upgrade.
 */
export function createMcpServer(
  options: { anonymous?: boolean } = {},
): McpServer {
  const anonymous = options.anonymous === true;
  // Advertise the MCP Apps UI extension so hosts negotiate UI support during
  // `initialize` (spec 2026-01-26, SEP-1724). Only declared when at least one
  // action ships a UI, keeping the capability surface minimal.
  const hasUiActions = api.actions.actions.some((a: Action) => a.mcp?.ui);
  const mcpServer = new McpServer(
    { name: pkg.name, version: pkg.version },
    {
      instructions: config.server.mcp.instructions,
      ...(hasUiActions
        ? {
            capabilities: {
              extensions: {
                [UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] },
              },
            },
          }
        : {}),
    },
  );

  registerTools(mcpServer, anonymous);
  registerResources(mcpServer, anonymous);
  registerUiResources(mcpServer, anonymous);
  registerPrompts(mcpServer, anonymous);

  return mcpServer;
}

/**
 * MCP Apps extension identifier used for capability negotiation during `initialize`.
 * @see https://github.com/modelcontextprotocol/ext-apps
 */
const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

/**
 * Compute the `ui://` resource URI for an action's MCP App.
 * Defaults to `ui://<tool-name>` when `mcp.ui.resourceUri` is not set.
 */
function uiResourceUri(action: Action): string {
  return action.mcp?.ui?.resourceUri ?? `ui://${formatToolName(action.name)}`;
}

/**
 * Build the MCP Apps `_meta.ui` object from an action's `mcp.ui` config,
 * omitting empty sub-objects so the resource metadata stays minimal.
 */
function buildUiMeta(ui: McpUiConfig): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (ui.csp && Object.keys(ui.csp).length > 0) meta.csp = ui.csp;
  if (ui.permissions && Object.keys(ui.permissions).length > 0) {
    meta.permissions = ui.permissions;
  }
  if (ui.prefersBorder !== undefined) meta.prefersBorder = ui.prefersBorder;
  if (ui.domain !== undefined) meta.domain = ui.domain;
  return meta;
}

function registerTools(mcpServer: McpServer, anonymous: boolean) {
  const registered = new Set<string>();
  for (const action of api.actions.actions) {
    // Tools are opt-in: register only actions that explicitly set `mcp.tool =
    // true`, or that declare an MCP App (`mcp.ui`) without opting out. Every
    // other action — including those with no `mcp` config — is never exposed.
    if (!isMcpTool(action)) continue;

    const toolName = formatToolName(action.name);
    if (registered.has(toolName)) continue;
    registered.add(toolName);
    const toolConfig: {
      description?: string;
      inputSchema?: any;
      _meta?: Record<string, unknown>;
    } = {};

    if (action.description) {
      toolConfig.description = action.description;
    }

    toolConfig.inputSchema = action.inputs
      ? sanitizeSchemaForMcp(action.inputs)
      : z4mini.strictObject({});

    // Link MCP App tools to their `ui://` resource so the host can preload and
    // render the UI. See https://modelcontextprotocol.io/extensions/apps/overview
    if (action.mcp?.ui) {
      toolConfig._meta = { ui: { resourceUri: uiResourceUri(action) } };
    }

    const tool = mcpServer.registerTool(
      toolName,
      toolConfig,
      async (
        args: Record<string, unknown>,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ) => {
        // Anonymous sessions may only call public tools. The HTTP layer already
        // answers such a call with a 401 challenge; this is the backstop.
        if (!isMcpAccessAllowed(action, extra.authInfo)) {
          const denied = mcpAuthenticationRequiredError(action);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: denied.message,
                  type: denied.type,
                }),
              },
            ],
            isError: true,
          };
        }

        const mcpSessionId = extra.sessionId || "";
        const connection = await createMcpConnection(extra, mcpServer);

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
            if (error instanceof McpUrlElicitationRequiredError) {
              throw new UrlElicitationRequiredError(
                error.elicitations,
                error.message,
              );
            }
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

          // MCP App responses carry both a text block (added to model context)
          // and structuredContent (delivered to the app UI for rendering).
          // ext-apps hosts render the UI from the tool's `_meta.ui.resourceUri`
          // and the separate `ui://` resource — the content array stays text-only.
          if (response instanceof UIResponse) {
            return {
              content: [{ type: "text" as const, text: response.text }],
              structuredContent: response.structuredContent,
            };
          }

          const format = action.mcp?.responseFormat ?? MCP_RESPONSE_FORMAT.JSON;
          const text =
            format === MCP_RESPONSE_FORMAT.MARKDOWN
              ? toMarkdown(response, {
                  maxDepth: config.server.mcp.markdownDepthLimit,
                })
              : JSON.stringify(response);

          // Promote plain object responses to structuredContent so MCP Apps can
          // bind without JSON.parse (same shape UIResponse already provides).
          const structuredContent =
            format === MCP_RESPONSE_FORMAT.JSON &&
            response !== null &&
            typeof response === "object" &&
            !Array.isArray(response)
              ? (response as Record<string, unknown>)
              : undefined;

          return {
            content: [{ type: "text" as const, text }],
            ...(structuredContent ? { structuredContent } : {}),
          };
        } finally {
          connection.destroy();
        }
      },
    );
    gateForAnonymous(mcpServer, action, tool, anonymous);
  }
}

function registerResources(mcpServer: McpServer, anonymous: boolean) {
  let registeredTemplate = false;
  for (const action of api.actions.actions) {
    if (!action.mcp?.resource) continue;
    const { uri, uriTemplate, mimeType } = action.mcp.resource;

    const readCb = async (
      mcpUri: URL,
      variables: Record<string, string | string[]>,
      extra: any,
    ) => {
      if (!isMcpAccessAllowed(action, extra.authInfo)) {
        throw mcpAuthenticationRequiredError(action);
      }
      const mcpSessionId = extra.sessionId || "";
      const connection = await createMcpConnection(extra, mcpServer);

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
      const resource = mcpServer.registerResource(
        formatToolName(action.name),
        new ResourceTemplate(uriTemplate, { list: undefined }),
        { description: action.description, mimeType },
        readCb,
      );
      gateForAnonymous(mcpServer, action, resource, anonymous);
      registeredTemplate = true;
    } else if (uri) {
      const resource = mcpServer.registerResource(
        formatToolName(action.name),
        uri,
        { description: action.description, mimeType },
        (mcpUri: URL, extra: any) => readCb(mcpUri, {}, extra),
      );
      gateForAnonymous(mcpServer, action, resource, anonymous);
    }
  }

  if (registeredTemplate) listOnlyEnabledResourceTemplates(mcpServer);
}

/**
 * Replace the SDK's `resources/templates/list` handler with one that skips
 * disabled templates. The SDK filters disabled entries out of `tools/list`,
 * `prompts/list`, and `resources/list`, but not out of the template list, so
 * without this an anonymous session would still see protected templates.
 */
function listOnlyEnabledResourceTemplates(mcpServer: McpServer): void {
  mcpServer.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => {
      const templates: Record<
        string,
        {
          enabled: boolean;
          resourceTemplate: ResourceTemplate;
          metadata?: Record<string, unknown>;
        }
      > =
        // @ts-expect-error -- the SDK keeps registered templates in a private field and exposes no public accessor
        mcpServer._registeredResourceTemplates;
      return {
        resourceTemplates: Object.entries(templates)
          .filter(([, template]) => template.enabled)
          .map(([name, template]) => ({
            name,
            uriTemplate: template.resourceTemplate.uriTemplate.toString(),
            ...template.metadata,
          })),
      };
    },
  );
}

/**
 * Register a `ui://` HTML resource for every action that declares `mcp.ui`.
 * The resource serves the app's self-contained HTML with the MCP Apps MIME type
 * and any `_meta.ui` (CSP, permissions, etc.). The matching tool is linked to it
 * via `_meta.ui.resourceUri` in `registerTools()`.
 */
function registerUiResources(mcpServer: McpServer, anonymous: boolean) {
  const registered = new Set<string>();
  for (const action of api.actions.actions) {
    const ui = action.mcp?.ui;
    if (!ui) continue;

    const resourceUri = uiResourceUri(action);
    if (registered.has(resourceUri)) {
      logger.warn(
        `Skipping duplicate MCP App UI resource '${resourceUri}' (action '${action.name}')`,
      );
      continue;
    }
    registered.add(resourceUri);

    // HTML is resolved (client bundled + inlined) once at boot; fall back to a
    // verbatim `html` string for actions registered outside the boot pass.
    const html = getResolvedMcpAppHtml(action) ?? ui.html ?? "";

    const uiMeta = buildUiMeta(ui);
    const hasMeta = Object.keys(uiMeta).length > 0;
    const metadata: Record<string, unknown> = { mimeType: MCP_APP_MIME_TYPE };
    if (hasMeta) metadata._meta = { ui: uiMeta };

    const uiResource = mcpServer.registerResource(
      `${formatToolName(action.name)}-ui`,
      resourceUri,
      metadata,
      (mcpUri: URL, extra: { authInfo?: McpAuthInfo }) => {
        if (!isMcpAccessAllowed(action, extra.authInfo)) {
          throw mcpAuthenticationRequiredError(action);
        }
        return {
          contents: [
            {
              uri: mcpUri.toString(),
              mimeType: MCP_APP_MIME_TYPE,
              text: html,
              ...(hasMeta ? { _meta: { ui: uiMeta } } : {}),
            },
          ],
        };
      },
    );
    gateForAnonymous(mcpServer, action, uiResource, anonymous);
  }
}

function registerPrompts(mcpServer: McpServer, anonymous: boolean) {
  for (const action of api.actions.actions) {
    if (!action.mcp?.prompt) continue;
    const { title } = action.mcp.prompt;

    const argsSchema = action.inputs
      ? sanitizeSchemaForMcp(action.inputs)?.shape
      : undefined;

    const prompt = mcpServer.registerPrompt(
      formatToolName(action.name),
      {
        title: title ?? action.name,
        description: action.description,
        argsSchema,
      },
      async (...cbArgs: any[]) => {
        // The SDK calls `cb(args, extra)` when the prompt declares an
        // argsSchema, but `cb(extra)` when it doesn't.
        const [args, extra] = argsSchema ? cbArgs : [{}, cbArgs[0]];
        if (!isMcpAccessAllowed(action, extra.authInfo)) {
          throw mcpAuthenticationRequiredError(action);
        }
        const mcpSessionId = extra.sessionId || "";
        const connection = await createMcpConnection(extra, mcpServer);

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
    gateForAnonymous(mcpServer, action, prompt, anonymous);
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
