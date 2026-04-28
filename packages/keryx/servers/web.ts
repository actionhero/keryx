import { parse } from "node:url";
import type { ServerWebSocket } from "bun";
import { randomUUID } from "crypto";
import { api, logger } from "../api";
import { type HTTP_METHOD } from "../classes/Action";
import { Connection } from "../classes/Connection";
import { Server } from "../classes/Server";
import { StreamingResponse } from "../classes/StreamingResponse";
import { ErrorStatusCodes, ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import type { PubSubMessage } from "../initializers/pubsub";
import { ansi } from "../util/ansi";
import { isOriginAllowed } from "../util/http";
import { compressResponse } from "../util/webCompression";
import {
  buildError,
  buildErrorPayload,
  buildResponse,
} from "../util/webResponse";
import {
  checkBodySize,
  determineActionName,
  parseRequestParams,
} from "../util/webRouting";
import {
  handleWebsocketAction,
  handleWebsocketSubscribe,
  handleWebsocketUnsubscribe,
} from "../util/webSocket";
import { handleStaticFile } from "../util/webStaticFiles";

/**
 * Per-request context passed to {@link BeforeRequestHook} and {@link AfterRequestHook}.
 * The same object instance is passed to both hooks for a given request, so `beforeRequest`
 * implementations can stash state (e.g. span refs, start time) in `metadata` for
 * `afterRequest` to pick up.
 */
export interface RequestContext {
  /** Client IP address as reported by `server.requestIP()`, or `"unknown-IP"`. */
  ip: string;
  /** Session id from the session cookie, or a freshly minted UUID. */
  id: string;
  /** Mutable scratch space shared between `beforeRequest` and `afterRequest`. */
  metadata: Record<string, unknown>;
}

/**
 * Outcome payload passed to {@link AfterRequestHook} describing the routed request.
 * `actionName` is `undefined` for paths that don't resolve to an action (static files,
 * OAuth/MCP endpoints, `/metrics`, 404s).
 */
export interface RequestOutcome {
  /** HTTP method (uppercased). */
  method: string;
  /** Response status code. */
  status: number;
  /** Resolved action name, if the request routed to an action. */
  actionName?: string;
  /** End-to-end handling time in milliseconds (measured at hook-fire time). */
  durationMs: number;
}

/**
 * Runs at the start of every HTTP request, before any routing or static file handling.
 * WebSocket upgrades do not fire this hook. Throwing an error propagates out of the
 * request handler. Hooks run sequentially in registration order.
 */
export type BeforeRequestHook = (
  req: Request,
  ctx: RequestContext,
) => Promise<void> | void;

/**
 * Runs after the `Response` is built and before compression. Receives the same `ctx`
 * object that was passed to the matching `beforeRequest`, plus a {@link RequestOutcome}
 * with the resolved routing decision (action name, status, duration). Hooks run
 * sequentially in registration order.
 */
export type AfterRequestHook = (
  req: Request,
  res: Response,
  ctx: RequestContext,
  outcome: RequestOutcome,
) => Promise<void> | void;

/**
 * Runs when a new WebSocket connection is accepted, after the {@link Connection}
 * has been constructed and registered. Register via `api.hooks.ws.onConnect(...)`.
 */
export type OnConnectHook = (connection: Connection) => Promise<void> | void;

/**
 * Runs for each inbound WebSocket message, after rate-limiting but before parsing.
 * Register via `api.hooks.ws.onMessage(...)`.
 */
export type OnMessageHook = (
  connection: Connection,
  message: string | Buffer,
) => Promise<void> | void;

/**
 * Runs when a WebSocket connection closes, before channel presence is cleaned up
 * and the connection is destroyed. Register via `api.hooks.ws.onDisconnect(...)`.
 */
export type OnDisconnectHook = (connection: Connection) => Promise<void> | void;

/**
 * HTTP + WebSocket server built on `Bun.serve`. Handles REST action routing (with path params),
 * static file serving (with ETag/304 caching), WebSocket connections (actions, PubSub subscribe/unsubscribe),
 * OAuth endpoints, and MCP SSE streams.
 *
 * Plugins register HTTP lifecycle hooks via `api.hooks.web.beforeRequest` /
 * `api.hooks.web.afterRequest`.
 */
export class WebServer extends Server<ReturnType<typeof Bun.serve>> {
  /** The actual port the server bound to (resolved after start, e.g. when config port is 0). */
  port: number = 0;
  /** The actual application URL (resolved after start). */
  url: string = "";
  /** Per-connection message rate tracking (keyed by connection id). */
  private wsRateMap = new Map<string, { count: number; windowStart: number }>();
  /** Set to true when the server is shutting down; rejects new WS upgrades. */
  private shuttingDown = false;

  constructor() {
    super("web");
  }

  async initialize() {}

  async start() {
    if (config.server.web.enabled !== true) return;
    this.shuttingDown = false;

    let startupAttempts = 0;
    try {
      const server = Bun.serve({
        port: config.server.web.port,
        hostname: config.server.web.host,
        fetch: this.handleIncomingConnection.bind(this),
        websocket: {
          maxPayloadLength: config.server.web.websocket.maxPayloadSize,
          open: this.handleWebSocketConnectionOpen.bind(this),
          message: this.handleWebSocketConnectionMessage.bind(this),
          close: this.handleWebSocketConnectionClose.bind(this),
        },
      });
      this.server = server;
      this.port = server.port ?? config.server.web.port;
      this.url = `http://${config.server.web.host}:${this.port}`;
      const startMessage = `started server @ ${this.url}`;
      logger.info(logger.colorize ? ansi.bgBlue(startMessage) : startMessage);
    } catch (e) {
      await Bun.sleep(1000);
      startupAttempts++;
    }
  }

  async stop() {
    if (this.server) {
      this.shuttingDown = true;

      // Send close frame to all WebSocket connections
      const wsConnections: ServerWebSocket[] = [];
      for (const connection of api.connections.connections.values()) {
        if (connection.type === "websocket" && connection.rawConnection) {
          wsConnections.push(connection.rawConnection);
        }
      }

      if (wsConnections.length > 0) {
        logger.info(
          `Draining ${wsConnections.length} WebSocket connection(s)...`,
        );

        for (const ws of wsConnections) {
          try {
            ws.close(1001, "Server shutting down");
          } catch (_e) {
            // Connection may already be closed
          }
        }

        // Wait for clients to disconnect gracefully, up to the drain timeout
        const drainTimeout = config.server.web.websocket.drainTimeout;
        const deadline = Date.now() + drainTimeout;
        while (Date.now() < deadline) {
          const remaining = [...api.connections.connections.values()].filter(
            (c) => c.type === "websocket",
          );
          if (remaining.length === 0) break;
          await Bun.sleep(50);
        }

        // Force-destroy any lingering WebSocket connections
        const lingering = [...api.connections.connections.values()].filter(
          (c) => c.type === "websocket",
        );
        for (const connection of lingering) {
          connection.destroy();
        }

        if (lingering.length > 0) {
          logger.info(
            `Force-closed ${lingering.length} lingering WebSocket connection(s)`,
          );
        }
      }

      this.server.stop(true);

      logger.info(
        `stopped app server @ ${config.server.web.host}:${config.server.web.port + 1}`,
      );
    }
  }

  /**
   * Main request handler passed to `Bun.serve({ fetch })`. Dispatches to WebSocket upgrade,
   * static files, OAuth, MCP, or REST action handling in that order.
   */
  async handleIncomingConnection(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
  ) {
    const ip = server.requestIP(req)?.address || "unknown-IP";
    const headers = req.headers;
    const cookies = new Bun.CookieMap(req.headers.get("cookie") ?? "");
    const id = cookies.get(config.session.cookieName) || randomUUID();

    // Reject new WebSocket upgrades during shutdown
    if (
      this.shuttingDown &&
      req.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return new Response("Server is shutting down", { status: 503 });
    }

    // Validate Origin header before WebSocket upgrade to prevent CSWSH
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const origin = req.headers.get("origin");
      if (origin && !isOriginAllowed(origin)) {
        return new Response("WebSocket origin not allowed", { status: 403 });
      }
    }

    if (
      server.upgrade(req, {
        data: { ip, id, wsConnectionId: randomUUID(), headers, cookies },
      })
    )
      return; // upgrade the request to a WebSocket

    const ctx: RequestContext = { ip, id, metadata: {} };
    const requestStart = Date.now();
    for (const hook of api.hooks.web.beforeRequestHooks) {
      await hook(req, ctx);
    }

    const { response, actionName } = await this.handleHttpRequest(
      req,
      server,
      ip,
      id,
    );

    const outcome: RequestOutcome = {
      method: req.method.toUpperCase(),
      status: response.status,
      actionName,
      durationMs: Date.now() - requestStart,
    };
    for (const hook of api.hooks.web.afterRequestHooks) {
      await hook(req, response, ctx, outcome);
    }

    // SSE and other streaming responses: disable idle timeout and skip compression
    if (response.headers.get("Content-Type")?.includes("text/event-stream")) {
      server.timeout(req, 0);
      return response;
    }

    return compressResponse(response, req);
  }

  /**
   * Routes an HTTP request to the appropriate handler (static files, OAuth, MCP, metrics, or actions).
   * Called after WebSocket upgrade handling; the returned Response is compressed by the caller.
   * Returns `actionName` alongside the response so `afterRequest` hooks can receive a
   * {@link RequestOutcome} without snooping on internal routing state.
   */
  private async handleHttpRequest(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
    ip: string,
    id: string,
  ): Promise<{ response: Response; actionName?: string }> {
    const parsedUrl = parse(req.url!, true);

    // Handle static file serving
    if (config.server.web.staticFiles.enabled && req.method === "GET") {
      const staticResponse = await handleStaticFile(req, parsedUrl);
      if (staticResponse) return { response: staticResponse };
    }

    // OAuth route interception (must come before MCP route check)
    if (config.server.mcp.enabled && api.oauth?.handleRequest) {
      const oauthResponse = await api.oauth.handleRequest(req, ip);
      if (oauthResponse) return { response: oauthResponse };
    }

    // MCP route interception
    if (config.server.mcp.enabled) {
      if (
        parsedUrl.pathname === config.server.mcp.route &&
        api.mcp?.handleRequest
      ) {
        server.timeout(req, 0); // disable idle timeout for long-lived MCP SSE streams
        return { response: await api.mcp.handleRequest(req, ip) };
      }
    }

    // Metrics endpoint
    if (
      config.observability.enabled &&
      parsedUrl.pathname === config.observability.metricsRoute
    ) {
      const body = await api.observability.collectMetrics();
      return {
        response: new Response(body || "", {
          status: 200,
          headers: {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          },
        }),
      };
    }

    // Don't route .well-known paths to actions (covers both root and
    // sub-path variants like /mcp/.well-known/openid-configuration)
    if (parsedUrl.pathname?.includes("/.well-known/")) {
      return { response: new Response(null, { status: 404 }) };
    }

    return this.handleWebAction(req, parsedUrl, ip, id);
  }

  /** Called when a new WebSocket connection opens. Creates a `Connection` and wires up broadcast delivery. */
  async handleWebSocketConnectionOpen(ws: ServerWebSocket) {
    //@ts-expect-error (ws.data is not defined in the bun types)
    const { ip, id, wsConnectionId } = ws.data;
    const connection = new Connection("websocket", ip, wsConnectionId, ws, id);
    connection.onBroadcastMessageReceived = function (payload: PubSubMessage) {
      ws.send(JSON.stringify({ message: payload }));
    };
    for (const hook of api.hooks.ws.onConnectHooks) {
      await hook(connection);
    }
    logger.info(
      `New websocket connection from ${connection.identifier} (${connection.id})`,
    );
  }

  /**
   * Called when a WebSocket message arrives. Parses JSON, enforces per-connection rate limiting,
   * and dispatches to action, subscribe, or unsubscribe handlers based on `messageType`.
   */
  async handleWebSocketConnectionMessage(
    ws: ServerWebSocket,
    message: string | Buffer,
  ) {
    const { connection } = api.connections.find(
      "websocket",
      //@ts-expect-error
      ws.data.ip,
      //@ts-expect-error
      ws.data.wsConnectionId,
    );

    if (!connection) {
      throw new TypedError({
        message: "No connection found",
        type: ErrorType.SERVER_INITIALIZATION,
      });
    }

    // Per-connection message rate limiting
    const maxMps = config.server.web.websocket.maxMessagesPerSecond;
    if (maxMps > 0) {
      const now = Date.now();
      const entry = this.wsRateMap.get(connection.id);
      if (!entry || now - entry.windowStart >= 1000) {
        this.wsRateMap.set(connection.id, { count: 1, windowStart: now });
      } else {
        entry.count++;
        if (entry.count > maxMps) {
          ws.send(
            JSON.stringify({
              error: buildErrorPayload(
                new TypedError({
                  message: "WebSocket rate limit exceeded",
                  type: ErrorType.CONNECTION_RATE_LIMITED,
                }),
              ),
            }),
          );
          return;
        }
      }
    }

    for (const hook of api.hooks.ws.onMessageHooks) {
      await hook(connection, message);
    }

    try {
      const parsedMessage = JSON.parse(message.toString());
      if (parsedMessage["messageType"] === "action") {
        handleWebsocketAction(connection, ws, parsedMessage);
      } else if (parsedMessage["messageType"] === "subscribe") {
        handleWebsocketSubscribe(connection, ws, parsedMessage);
      } else if (parsedMessage["messageType"] === "unsubscribe") {
        handleWebsocketUnsubscribe(connection, ws, parsedMessage);
      } else {
        throw new TypedError({
          message: `messageType either missing or unknown`,
          type: ErrorType.CONNECTION_TYPE_NOT_FOUND,
        });
      }
    } catch (e) {
      ws.send(
        JSON.stringify({
          error: buildErrorPayload(
            new TypedError({
              message: `${e}`,
              type: ErrorType.CONNECTION_ACTION_RUN,
            }),
          ),
        }),
      );
    }
  }

  /** Called when a WebSocket connection closes. Removes presence from all channels and destroys the connection. */
  async handleWebSocketConnectionClose(ws: ServerWebSocket) {
    const { connection } = api.connections.find(
      "websocket",
      //@ts-expect-error
      ws.data.ip,
      //@ts-expect-error
      ws.data.wsConnectionId,
    );
    if (!connection) return;

    for (const hook of api.hooks.ws.onDisconnectHooks) {
      await hook(connection);
    }
    this.wsRateMap.delete(connection.id);

    try {
      // Remove presence from all subscribed channels before destroying
      for (const channel of connection.subscriptions) {
        try {
          await api.channels.removePresence(channel, connection);
        } catch (e) {
          logger.error(`Error removing presence on close: ${e}`);
        }
      }

      connection.destroy();
      logger.info(
        `websocket connection closed from ${connection.identifier} (${connection.id})`,
      );
    } catch (e) {
      logger.error(`Error destroying connection: ${e}`);
    }
  }

  async handleWebAction(
    req: Request,
    url: ReturnType<typeof parse>,
    ip: string,
    id: string,
  ): Promise<{ response: Response; actionName?: string }> {
    if (!this.server) {
      throw new TypedError({
        message: "Server server not started",
        type: ErrorType.SERVER_START,
      });
    }

    let errorStatusCode = 500;
    const httpMethod = req.method?.toUpperCase() as HTTP_METHOD;

    const connection = new Connection("web", ip, id);

    if (
      config.server.web.correlationId.header &&
      config.server.web.correlationId.trustProxy
    ) {
      const incomingId = req.headers.get(
        config.server.web.correlationId.header,
      );
      if (incomingId) connection.correlationId = incomingId;
    }

    const requestOrigin = req.headers.get("origin") ?? undefined;

    // Handle OPTIONS requests.
    // As we don't really know what action the client wants (HTTP Method is always OPTIONS), we just return a 200 response.
    if (httpMethod === "OPTIONS") {
      return { response: buildResponse(connection, {}, 200, requestOrigin) };
    }

    // Reject oversized request bodies before reading them
    try {
      checkBodySize(req);
    } catch (e) {
      connection.destroy();
      if (e instanceof TypedError) {
        return {
          response: buildError(connection, e, 413, requestOrigin),
        };
      }
      throw e;
    }

    const { actionName, pathParams } = await determineActionName(
      url,
      httpMethod,
    );
    if (!actionName) errorStatusCode = 404;

    let params: Record<string, unknown>;
    try {
      params = await parseRequestParams(req, url, pathParams ?? undefined);
    } catch (e) {
      if (
        e instanceof TypedError &&
        e.message.startsWith("Payload Too Large")
      ) {
        connection.destroy();
        return { response: buildError(connection, e, 413, requestOrigin) };
      }
      throw e;
    }

    const { response, error } = await connection.act(
      actionName!,
      params,
      httpMethod,
      req.url,
    );

    // For streaming responses, defer connection cleanup until the stream closes
    if (response instanceof StreamingResponse) {
      response.onClose = () => {
        connection.destroy();
      };
      return {
        response: buildResponse(connection, response, 200, requestOrigin),
        actionName: actionName ?? undefined,
      };
    }

    connection.destroy();

    if (error && ErrorStatusCodes[error.type]) {
      errorStatusCode = ErrorStatusCodes[error.type];
    }

    return {
      response: error
        ? buildError(connection, error, errorStatusCode, requestOrigin)
        : buildResponse(connection, response, 200, requestOrigin),
      actionName: actionName ?? undefined,
    };
  }
}
