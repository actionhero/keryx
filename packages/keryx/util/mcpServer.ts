import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  type ServerNotification,
  type ServerRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import * as z4mini from "zod/v4-mini";
import { api, logger } from "../api";
import type { Action, McpUiConfig } from "../classes/Action";
import { MCP_APP_MIME_TYPE, MCP_RESPONSE_FORMAT } from "../classes/Action";
import { CONNECTION_TYPE, Connection } from "../classes/Connection";
import { StreamingResponse } from "../classes/StreamingResponse";
import { ErrorType, TypedError } from "../classes/TypedError";
import { UIResponse } from "../classes/UIResponse";
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
    CONNECTION_TYPE.MCP,
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
    config.server.mcp.sessionTtl,
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
 */
export async function refreshMcpSessionTtl(sessionId: string): Promise<void> {
  await api.redis.redis.expire(
    mcpSessionKey(sessionId),
    config.server.mcp.sessionTtl,
  );
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
 * @returns The connected, initialized transport (also registered in `api.mcp.transports`).
 */
export async function adoptMcpSession(
  sessionId: string,
  clientId: string,
  protocolVersion: string | undefined,
): Promise<WebStandardStreamableHTTPServerTransport> {
  const inFlight = adoptionsInFlight.get(sessionId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const mcpServer = createMcpServer();
    api.mcp.mcpServers.push(mcpServer);
    try {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        enableJsonResponse: true,
        // Local registration only — no hooks, no registry write (see doc above).
        onsessioninitialized: (sid) => {
          api.mcp.transports.set(sid, { transport, clientId });
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
  registerUiResources(mcpServer);
  registerPrompts(mcpServer);

  return mcpServer;
}

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

    mcpServer.registerTool(
      toolName,
      toolConfig,
      async (
        args: Record<string, unknown>,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ) => {
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

          // MCP App responses carry both a text block (added to model context)
          // and structuredContent (delivered to the app UI for rendering).
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

/**
 * Register a `ui://` HTML resource for every action that declares `mcp.ui`.
 * The resource serves the app's self-contained HTML with the MCP Apps MIME type
 * and any `_meta.ui` (CSP, permissions, etc.). The matching tool is linked to it
 * via `_meta.ui.resourceUri` in `registerTools()`.
 */
function registerUiResources(mcpServer: McpServer) {
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

    const uiMeta = buildUiMeta(ui);
    const hasMeta = Object.keys(uiMeta).length > 0;
    const metadata: Record<string, unknown> = { mimeType: MCP_APP_MIME_TYPE };
    if (hasMeta) metadata._meta = { ui: uiMeta };

    mcpServer.registerResource(
      `${formatToolName(action.name)}-ui`,
      resourceUri,
      metadata,
      (mcpUri: URL) => ({
        contents: [
          {
            uri: mcpUri.toString(),
            mimeType: MCP_APP_MIME_TYPE,
            text: ui.html,
            ...(hasMeta ? { _meta: { ui: uiMeta } } : {}),
          },
        ],
      }),
    );
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
