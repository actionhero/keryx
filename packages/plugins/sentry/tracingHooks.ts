import * as Sentry from "@sentry/bun";
import { api, CONNECTION_TYPE, config } from "keryx";
import {
  isActionTraced,
  isDroppableTransportSpan,
  markSpanSkipped,
  matchWebActionName,
  peekWsActionName,
  peekWsMessageType,
  type SentrySpan,
  shouldCapture,
} from "./spanHelpers";
import type { RequestScopeData, SentryRequestState } from "./state";
import { recordActionMetric } from "./telemetry";

/**
 * Wire up Sentry spans and exception capture via framework hooks:
 *  - `web.beforeRequest` / `web.afterRequest`: root HTTP span
 *  - `ws.onConnect` / `onMessage` / `onDisconnect`: WebSocket transport
 *  - `mcp.onConnect` / `onMessage` / `onDisconnect`: MCP transport
 *  - `actions.beforeAct` / `actions.afterAct`: action span + errors + metric
 *  - `actions.onEnqueue`: inject Sentry trace headers into task params
 *  - `resque.beforeJob` / `afterJob`: root `queue.process` transaction that
 *    continues the enqueuer's trace
 *
 * @param state - Shared per-request span / identity state the hooks read and
 *   write (async stores plus transport span bookkeeping).
 */
export function registerTracingHooks(state: SentryRequestState) {
  api.hooks.web.beforeRequest((req, ctx) => {
    ctx.metadata.sentryPrevSuppressed =
      state.tracingSuppressedALS.getStore() === true;
    ctx.metadata.sentryPrevSpan = state.spanALS.getStore();
    const actionName = matchWebActionName(req);
    if (!isActionTraced(actionName)) {
      ctx.metadata.sentryTracingSuppressed = true;
      state.tracingSuppressedALS.enterWith(true);
      state.spanALS.enterWith(undefined);
      return;
    }
    // Jobs/requests are top-level: clear a flag left by a previous opted-out
    // job on this async context (node-resque workers reuse one). Nested
    // `connection.act()` still goes through beforeAct, which preserves
    // an outer request's suppress.
    state.tracingSuppressedALS.enterWith(false);

    const method = req.method?.toUpperCase() ?? "";
    const sentryTrace = req.headers.get("sentry-trace") ?? undefined;
    const baggage = req.headers.get("baggage") ?? undefined;
    const start = () =>
      Sentry.startInactiveSpan({
        name: method || "HTTP",
        op: "http.server",
        forceTransaction: true,
        attributes: {
          "http.request.method": method,
          "url.full": req.url,
        },
      });
    const httpSpan =
      sentryTrace || baggage
        ? Sentry.continueTrace({ sentryTrace, baggage }, start)
        : start();
    ctx.metadata.sentrySpan = httpSpan;
    state.spanALS.enterWith(httpSpan);
  });

  api.hooks.web.afterRequest((_req, _res, ctx, outcome) => {
    try {
      if (ctx.metadata.sentryTracingSuppressed) return;
      const httpSpan = ctx.metadata.sentrySpan as SentrySpan | undefined;
      if (!httpSpan) return;
      if (!isActionTraced(outcome.actionName)) {
        markSpanSkipped(httpSpan);
        httpSpan.end();
        return;
      }
      httpSpan.setAttribute("http.response.status_code", outcome.status);
      if (outcome.actionName) {
        httpSpan.setAttribute("http.route", outcome.actionName);
        Sentry.updateSpanName(
          httpSpan,
          `${outcome.method} ${outcome.actionName}`,
        );
      }
      if (outcome.status >= 400) {
        httpSpan.setStatus({ code: 2 });
      } else {
        httpSpan.setStatus({ code: 1 });
      }
      httpSpan.end();
    } finally {
      state.spanALS.enterWith(
        ctx.metadata.sentryPrevSpan as SentrySpan | undefined,
      );
      state.tracingSuppressedALS.enterWith(
        ctx.metadata.sentryPrevSuppressed === true,
      );
    }
  });

  api.hooks.ws.onConnect((connection) => {
    const span = Sentry.startInactiveSpan({
      name: "ws.connect",
      op: "ws.server",
      forceTransaction: true,
      attributes: {
        "keryx.connection.type": CONNECTION_TYPE.WEBSOCKET,
        "keryx.connection.id": connection.id,
      },
    });
    state.wsConnections.set(connection, span);
    state.spanALS.enterWith(span);
  });

  api.hooks.ws.onMessage((connection, message) => {
    const messageType = peekWsMessageType(message);
    const parent = state.wsConnections.get(connection);

    if (
      messageType === "action" &&
      !isActionTraced(peekWsActionName(message))
    ) {
      // Skip the per-message span; `beforeAct` / `afterAct` own the
      // suppress flag so it cannot stick to this long-lived connection.
      if (parent) state.spanALS.enterWith(parent);
      return;
    }

    const span = Sentry.startInactiveSpan({
      name: `ws.message ${messageType}`,
      op: "ws.server",
      parentSpan: parent,
      attributes: {
        "keryx.connection.type": CONNECTION_TYPE.WEBSOCKET,
        "keryx.connection.id": connection.id,
        "keryx.ws.message_type": messageType,
      },
    });
    state.spanALS.enterWith(span);
    if (messageType === "action") {
      // End any previous in-flight action span for this connection before
      // overwriting the slot, so a burst of messages can't leak spans that
      // never reach afterAct.
      const prev = state.wsMessageSpans.get(connection);
      if (prev && prev !== span) prev.end();
      state.wsMessageSpans.set(connection, span);
    } else {
      span.setStatus({ code: 1 });
      span.end();
    }
  });

  api.hooks.ws.onDisconnect((connection) => {
    const pending = state.wsMessageSpans.get(connection);
    if (pending) {
      pending.end();
      state.wsMessageSpans.delete(connection);
    }
    const span = state.wsConnections.get(connection);
    if (!span) return;
    span.setStatus({ code: 1 });
    span.end();
    state.wsConnections.delete(connection);
  });

  api.hooks.mcp.onConnect((sessionId) => {
    const span = Sentry.startInactiveSpan({
      name: "mcp.connect",
      op: "mcp.server",
      forceTransaction: true,
      attributes: {
        "keryx.connection.type": CONNECTION_TYPE.MCP,
        "keryx.mcp.session_id": sessionId,
      },
    });
    state.mcpSessions.set(sessionId, span);
    state.spanALS.enterWith(span);
  });

  api.hooks.mcp.onMessage((sessionId) => {
    const parent = sessionId ? state.mcpSessions.get(sessionId) : undefined;
    const span = Sentry.startInactiveSpan({
      name: "mcp.message",
      op: "mcp.server",
      parentSpan: parent,
      attributes: {
        "keryx.connection.type": CONNECTION_TYPE.MCP,
        ...(sessionId ? { "keryx.mcp.session_id": sessionId } : {}),
      },
    });
    state.spanALS.enterWith(span);
    if (sessionId) {
      // onMessage fires for every session request — including pings and
      // notifications that never reach afterAct. End any previous in-flight
      // message span before overwriting the slot so those never accumulate
      // until disconnect.
      const prev = state.mcpMessageSpans.get(sessionId);
      if (prev && prev !== span) prev.end();
      state.mcpMessageSpans.set(sessionId, span);
    } else {
      span.setStatus({ code: 1 });
      span.end();
    }
  });

  api.hooks.mcp.onDisconnect((sessionId) => {
    const pending = state.mcpMessageSpans.get(sessionId);
    if (pending) {
      pending.end();
      state.mcpMessageSpans.delete(sessionId);
    }
    const span = state.mcpSessions.get(sessionId);
    if (!span) return;
    span.setStatus({ code: 1 });
    span.end();
    state.mcpSessions.delete(sessionId);
  });

  api.hooks.actions.beforeAct((actionName, _params, connection, actCtx) => {
    // Give each action its own identity buffer, seeded from the parent so a
    // nested connection.act() inherits the outer user/tags without mutating
    // them. afterAct restores the previous buffer, so sequential actions on a
    // long-lived async context (a WS connection or a task worker) never
    // inherit stale identity and it never bleeds across requests.
    const prevScope = state.requestScopeALS.getStore();
    actCtx.metadata.sentryPrevScope = prevScope;
    state.requestScopeALS.enterWith(
      prevScope
        ? { user: prevScope.user, tags: { ...prevScope.tags } }
        : { tags: {} },
    );

    const prevSuppressed = state.tracingSuppressedALS.getStore() === true;
    actCtx.metadata.sentryPrevSuppressed = prevSuppressed;

    if (!isActionTraced(actionName)) {
      const parent = state.spanALS.getStore();
      if (parent && isDroppableTransportSpan(parent)) {
        markSpanSkipped(parent);
      }
      state.tracingSuppressedALS.enterWith(true);
      actCtx.metadata.sentryParentSpan = parent;
      return;
    }

    const parent = state.spanALS.getStore();
    const actionSpan = Sentry.startInactiveSpan({
      name: `action:${actionName ?? "unknown"}`,
      op: "keryx.action",
      parentSpan: parent,
      attributes: {
        "keryx.action": actionName ?? "unknown",
        "keryx.connection.type": connection.type,
      },
    });
    actCtx.metadata.sentrySpan = actionSpan;
    actCtx.metadata.sentryParentSpan = parent;
    state.spanALS.enterWith(actionSpan);
  });

  api.hooks.actions.afterAct(
    (actionName, _params, connection, actCtx, outcome) => {
      recordActionMetric(actionName, connection.type, outcome);

      const span = actCtx.metadata.sentrySpan as SentrySpan | undefined;
      const parent = actCtx.metadata.sentryParentSpan as SentrySpan | undefined;
      if (span) {
        span.setAttribute("keryx.action.duration_ms", outcome.duration);
        if (!outcome.success) {
          span.setStatus({
            code: 2,
            message:
              outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error),
          });
        } else {
          span.setStatus({ code: 1 });
        }
        span.end();
      }

      if (
        !outcome.success &&
        shouldCapture(outcome.error, config.sentry.captureClientErrors)
      ) {
        Sentry.withScope((scope) => {
          state.applyRequestScope(scope);
          scope.setTag("keryx.action", actionName);
          scope.setTag("keryx.connection.type", connection.type);
          Sentry.captureException(outcome.error);
        });
      }

      // Nested connection.act() must not close the transport span — only the
      // outermost action (whose parent is the message/session span) does.
      if (connection.type === CONNECTION_TYPE.WEBSOCKET) {
        const messageSpan = state.wsMessageSpans.get(connection);
        if (messageSpan && messageSpan === parent) {
          messageSpan.setStatus({ code: outcome.success ? 1 : 2 });
          messageSpan.end();
          state.wsMessageSpans.delete(connection);
        }
      }
      if (connection.type === CONNECTION_TYPE.MCP) {
        let mcpSessionId: string | undefined;
        if (parent) {
          for (const [sid, s] of state.mcpMessageSpans) {
            if (s === parent) {
              mcpSessionId = sid;
              break;
            }
          }
        }
        if (parent && mcpSessionId !== undefined) {
          parent.setStatus({ code: outcome.success ? 1 : 2 });
          parent.end();
          state.mcpMessageSpans.delete(mcpSessionId);
        }
      }

      if (parent) state.spanALS.enterWith(parent);
      // Restore the identity buffer captured in beforeAct so this action's
      // user/tags do not leak into sibling or sequential actions sharing the
      // same async context (e.g. a task worker or WS connection).
      state.requestScopeALS.enterWith(
        actCtx.metadata.sentryPrevScope as RequestScopeData | undefined,
      );
      state.tracingSuppressedALS.enterWith(
        actCtx.metadata.sentryPrevSuppressed === true,
      );
    },
  );

  api.hooks.actions.onEnqueue((_actionName, inputs) => {
    if (!api.sentry.enabled) return;
    if (state.tracingSuppressedALS.getStore()) return;
    const parent = state.spanALS.getStore();
    if (!parent) return;
    // Ended spans (afterJob has already closed the job root) must not
    // propagate into enqueueRecurrent — that would chain cron runs.
    // Unsampled *live* spans still propagate so workers honor head sampling.
    if (typeof Sentry.spanToJSON(parent).timestamp === "number") return;
    const ctx = parent.spanContext();
    if (!ctx.traceId || !ctx.spanId) return;
    const sampled = ctx.traceFlags & 1 ? 1 : 0;
    const next: Record<string, unknown> = { ...inputs };
    next._sentryTrace = `${ctx.traceId}-${ctx.spanId}-${sampled}`;
    const baggage = Sentry.withActiveSpan(parent, () =>
      Sentry.getTraceData(),
    ).baggage;
    if (baggage) next._sentryBaggage = baggage;
    return next;
  });

  api.hooks.resque.beforeJob((actionName, params, jobCtx) => {
    jobCtx.metadata.sentryPrevSuppressed =
      state.tracingSuppressedALS.getStore() === true;
    jobCtx.metadata.sentryPrevSpan = state.spanALS.getStore();
    const p = params as Record<string, unknown>;
    const sentryTrace = p._sentryTrace as string | undefined;
    const baggage = p._sentryBaggage as string | undefined;
    // Strip internal trace-propagation fields so they never reach the
    // action's validated params.
    delete p._sentryTrace;
    delete p._sentryBaggage;

    if (!isActionTraced(actionName)) {
      state.tracingSuppressedALS.enterWith(true);
      state.spanALS.enterWith(undefined);
      return;
    }
    // See beforeRequest: traced jobs must not inherit a leaked suppress flag.
    state.tracingSuppressedALS.enterWith(false);

    const start = () =>
      Sentry.startInactiveSpan({
        name: `task:${actionName}`,
        op: "queue.process",
        forceTransaction: true,
        attributes: {
          "keryx.action": actionName,
          "keryx.connection.type": CONNECTION_TYPE.TASK,
          "messaging.destination.name": jobCtx.queue || "default",
        },
      });
    const jobSpan =
      sentryTrace || baggage
        ? Sentry.continueTrace({ sentryTrace, baggage }, start)
        : start();
    jobCtx.metadata.sentrySpan = jobSpan;
    state.spanALS.enterWith(jobSpan);
  });

  api.hooks.resque.afterJob((_actionName, _params, jobCtx, outcome) => {
    try {
      const jobSpan = jobCtx.metadata.sentrySpan as SentrySpan | undefined;
      if (!jobSpan) return;
      if (outcome.success) {
        jobSpan.setStatus({ code: 1 });
      } else {
        jobSpan.setStatus({
          code: 2,
          message:
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error),
        });
      }
      jobSpan.end();
    } finally {
      state.spanALS.enterWith(
        jobCtx.metadata.sentryPrevSpan as SentrySpan | undefined,
      );
      state.tracingSuppressedALS.enterWith(
        jobCtx.metadata.sentryPrevSuppressed === true,
      );
    }
  });
}
