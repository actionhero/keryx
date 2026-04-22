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
import { determineActionName, parseRequestParams } from "../util/webRouting";
import {
  handleWebsocketAction,
  handleWebsocketSubscribe,
  handleWebsocketUnsubscribe,
} from "../util/webSocket";
import { handleStaticFile } from "../util/webStaticFiles";

/**
 * HTTP + WebSocket server built on `Bun.serve`. Handles REST action routing (with path params),
 * static file serving (with ETag/304 caching), WebSocket connections (actions, PubSub subscribe/unsubscribe),
 * OAuth endpoints, and MCP SSE streams. Exposes `api.servers.web`.
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

    const response = await this.handleHttpRequest(req, server, ip, id);

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
   */
  private async handleHttpRequest(
    req: Request,
    server: ReturnType<typeof Bun.serve>,
    ip: string,
    id: string,
  ): Promise<Response> {
    const parsedUrl = parse(req.url!, true);

    // Handle static file serving
    if (config.server.web.staticFiles.enabled && req.method === "GET") {
      const staticResponse = await handleStaticFile(req, parsedUrl);
      if (staticResponse) return staticResponse;
    }

    // OAuth route interception (must come before MCP route check)
    if (config.server.mcp.enabled && api.oauth?.handleRequest) {
      const oauthResponse = await api.oauth.handleRequest(req, ip);
      if (oauthResponse) return oauthResponse;
    }

    // MCP route interception
    if (config.server.mcp.enabled) {
      if (
        parsedUrl.pathname === config.server.mcp.route &&
        api.mcp?.handleRequest
      ) {
        server.timeout(req, 0); // disable idle timeout for long-lived MCP SSE streams
        return api.mcp.handleRequest(req, ip);
      }
    }

    // Metrics endpoint
    if (
      config.observability.enabled &&
      parsedUrl.pathname === config.observability.metricsRoute
    ) {
      const body = await api.observability.collectMetrics();
      return new Response(body || "", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        },
      });
    }

    // Don't route .well-known paths to actions (covers both root and
    // sub-path variants like /mcp/.well-known/openid-configuration)
    if (parsedUrl.pathname?.includes("/.well-known/")) {
      return new Response(null, { status: 404 });
    }

    return this.handleWebAction(req, parsedUrl, ip, id);
  }

  /** Called when a new WebSocket connection opens. Creates a `Connection` and wires up broadcast delivery. */
  handleWebSocketConnectionOpen(ws: ServerWebSocket) {
    //@ts-expect-error (ws.data is not defined in the bun types)
    const { ip, id, wsConnectionId } = ws.data;
    const connection = new Connection("websocket", ip, wsConnectionId, ws, id);
    connection.onBroadcastMessageReceived = function (payload: PubSubMessage) {
      ws.send(JSON.stringify({ message: payload }));
    };
    api.observability.ws.connections.add(1);
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

    api.observability.ws.messagesTotal.add(1);

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

    api.observability.ws.connections.add(-1);
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
  ) {
    if (!this.server) {
      throw new TypedError({
        message: "Server server not started",
        type: ErrorType.SERVER_START,
      });
    }

    const httpStartTime = Date.now();
    let errorStatusCode = 500;
    const httpMethod = req.method?.toUpperCase() as HTTP_METHOD;

    api.observability.http.activeConnections.add(1);
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
    if (httpMethod === "OPTIONS")
      return buildResponse(connection, {}, 200, requestOrigin);

    const { actionName, pathParams } = await determineActionName(
      url,
      httpMethod,
    );
    if (!actionName) errorStatusCode = 404;

    const params = await parseRequestParams(req, url, pathParams ?? undefined);

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
        api.observability.http.activeConnections.add(-1);
      };

      api.observability.http.requestsTotal.add(1, {
        method: httpMethod,
        route: actionName ?? "unknown",
        status: "200",
      });

      return buildResponse(connection, response, 200, requestOrigin);
    }

    connection.destroy();
    api.observability.http.activeConnections.add(-1);

    if (error && ErrorStatusCodes[error.type]) {
      errorStatusCode = ErrorStatusCodes[error.type];
    }

    const statusCode = error ? errorStatusCode : 200;
    api.observability.http.requestsTotal.add(1, {
      method: httpMethod,
      route: actionName ?? "unknown",
      status: String(statusCode),
    });
    api.observability.http.requestDuration.record(Date.now() - httpStartTime, {
      method: httpMethod,
      route: actionName ?? "unknown",
      status: String(statusCode),
    });

    return error
      ? buildError(connection, error, errorStatusCode, requestOrigin)
      : buildResponse(connection, response, 200, requestOrigin);
  }
}
