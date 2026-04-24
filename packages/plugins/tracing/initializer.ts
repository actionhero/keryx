import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { instrumentDrizzleClient } from "@kubiks/otel-drizzle";
import {
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  type SpanOptions,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { api, config, Initializer, logger } from "keryx";

const namespace = "tracing";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<TracingPlugin["initialize"]>>;
  }
}

/**
 * Per-request state used to link HTTP spans with their child action spans
 * and to update the HTTP span name/attributes once the action is resolved.
 */
interface RequestState {
  httpSpan: Span;
  method: string;
  parentCtx: Context;
}

/**
 * OpenTelemetry tracing plugin for Keryx. Provides OTLP distributed tracing for
 * HTTP requests, actions, background tasks, Redis commands, and Drizzle DB
 * queries via framework hooks (`api.hooks.*`) — no direct core modifications.
 *
 * Exposes `api.tracing` (no-op by default). Metrics are handled by the core
 * `Observability` initializer; this plugin is tracing-only.
 *
 * Register via `config/plugins.ts`:
 * ```ts
 * import { tracingPlugin } from "@keryxjs/tracing";
 * export default { plugins: [tracingPlugin] };
 * ```
 *
 * Enable with `OTEL_TRACING_ENABLED=true`.
 */
export class TracingPlugin extends Initializer {
  private tracerProvider?: BasicTracerProvider;

  /**
   * Plugin-owned AsyncLocalStorage for per-request trace context state. Set in
   * `beforeRequest` via `enterWith` so that `beforeAct` can update the HTTP span's
   * name with the resolved action route without needing to wrap subsequent hook
   * calls with `context.with`.
   */
  private requestALS = new AsyncLocalStorage<RequestState>();

  /**
   * Plugin-owned AsyncLocalStorage for the parent trace context to use when
   * creating action spans (and their descendants: Redis, Drizzle). Set in
   * `beforeRequest` (to the HTTP span's context) and `beforeJob` (to the
   * extracted task trace context).
   */
  private parentCtxALS = new AsyncLocalStorage<Context>();

  constructor() {
    super(namespace);
    this.dependsOn = ["hooks", "actions", "connections", "servers"];
  }

  async initialize() {
    return {
      enabled: false,
      tracer: createNoopTracer(),
      extractContext: (_headers: Headers): Context => context.active(),
      injectContext: (_carrier: Record<string, string>): void => {},
    };
  }

  async start() {
    if (!config.tracing.enabled) return;

    // Resolve service name: env var > app package.json name > "keryx"
    let appPkgName: string | undefined;
    try {
      const appPkg = (await Bun.file(
        path.join(api.rootDir, "package.json"),
      ).json()) as { name?: string };
      appPkgName = appPkg.name;
    } catch {
      // ignore — api.rootDir may not have a package.json in tests
    }
    const serviceName =
      config.observability.serviceName || appPkgName || "keryx";

    this.startTracing(serviceName);
    this.registerTracingHooks();
    this.instrumentRedis();
    this.instrumentDrizzle();
  }

  private startTracing(serviceName: string) {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    });

    const exporter = new OTLPTraceExporter({
      url: `${config.tracing.otlpEndpoint}/v1/traces`,
    });

    const sampler = new TraceIdRatioBasedSampler(config.tracing.sampleRate);

    this.tracerProvider = new BasicTracerProvider({
      resource,
      sampler,
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          maxQueueSize: config.tracing.spanQueueSize,
          maxExportBatchSize: config.tracing.spanBatchSize,
          scheduledDelayMillis: config.tracing.spanExportDelayMs,
        }),
      ],
    });

    // Register AsyncLocalStorage-based context manager so spans propagate
    // across async boundaries (required for parent-child span relationships).
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(this.tracerProvider);

    const ns = api.tracing;
    ns.enabled = true;
    ns.tracer = trace.getTracer(serviceName);

    ns.extractContext = (headers: Headers): Context => {
      return propagation.extract(context.active(), headers, {
        get(carrier, key) {
          return carrier.get(key) ?? undefined;
        },
        keys(carrier) {
          return [...carrier.keys()];
        },
      });
    };

    ns.injectContext = (carrier: Record<string, string>): void => {
      propagation.inject(context.active(), carrier);
    };

    logger.info(`Observability tracing initialized (service: ${serviceName})`);
  }

  /**
   * Wire up distributed tracing end-to-end via framework hooks:
   *  - `web.beforeRequest` / `web.afterRequest`: root HTTP span per request
   *  - `actions.beforeAct` / `actions.afterAct`: child action span
   *  - `actions.onEnqueue`: inject W3C trace headers into task params
   *  - `resque.beforeJob`: extract trace context from task params, establish as parent
   */
  private registerTracingHooks() {
    const tracing = api.tracing;

    api.hooks.web.beforeRequest((req, ctx) => {
      const method = req.method?.toUpperCase() ?? "";
      const parentCtx = tracing.extractContext(req.headers);
      const httpSpan = tracing.tracer.startSpan(
        method || "HTTP",
        {
          kind: SpanKind.SERVER,
          attributes: {
            "http.request.method": method,
            "url.full": req.url,
          },
        },
        parentCtx,
      );
      const httpCtx = trace.setSpan(parentCtx, httpSpan);
      ctx.metadata.otelSpan = httpSpan;
      // enterWith persists the store for the remainder of this async task,
      // so beforeAct (downstream) can read it without an enclosing callback.
      this.requestALS.enterWith({ httpSpan, method, parentCtx: httpCtx });
      this.parentCtxALS.enterWith(httpCtx);
    });

    api.hooks.web.afterRequest((_req, _res, ctx, outcome) => {
      const httpSpan = ctx.metadata.otelSpan as Span | undefined;
      if (!httpSpan) return;
      httpSpan.setAttribute("http.response.status_code", outcome.status);
      if (outcome.actionName) {
        httpSpan.setAttribute("http.route", outcome.actionName);
      }
      if (outcome.status >= 400) {
        httpSpan.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        httpSpan.setStatus({ code: SpanStatusCode.OK });
      }
      httpSpan.end();
    });

    api.hooks.actions.beforeAct((actionName, _params, connection, actCtx) => {
      const parentCtx = this.parentCtxALS.getStore() ?? context.active();

      // For web requests, update the HTTP span's name with the resolved route
      // once we know it. The request state (with HTTP span ref) was stashed
      // in ALS by beforeRequest.
      if (connection.type === "web") {
        const state = this.requestALS.getStore();
        if (state) {
          state.httpSpan.updateName(
            `${state.method} ${actionName ?? "unknown"}`,
          );
        }
      }

      const actionSpan = tracing.tracer.startSpan(
        `action:${actionName ?? "unknown"}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "keryx.action": actionName ?? "unknown",
            "keryx.connection.type": connection.type,
          },
        },
        parentCtx,
      );
      actCtx.metadata.otelSpan = actionSpan;
      // Make the action span the active parent so Redis/DB spans emitted
      // during the action become children of it.
      this.parentCtxALS.enterWith(trace.setSpan(parentCtx, actionSpan));
    });

    api.hooks.actions.afterAct(
      (_actionName, _params, _connection, actCtx, outcome) => {
        const span = actCtx.metadata.otelSpan as Span | undefined;
        if (!span) return;
        span.setAttribute("keryx.action.duration_ms", outcome.duration);
        if (!outcome.success) {
          const err = outcome.error;
          if (err instanceof Error) span.recordException(err);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
      },
    );

    api.hooks.actions.onEnqueue((_actionName, inputs) => {
      if (!tracing.enabled) return;
      const carrier: Record<string, string> = {};
      tracing.injectContext(carrier);
      if (!carrier.traceparent) return;
      const next: Record<string, unknown> = { ...inputs };
      next._traceParent = carrier.traceparent;
      if (carrier.tracestate) next._traceState = carrier.tracestate;
      return next;
    });

    api.hooks.resque.beforeJob((_actionName, params, _ctx) => {
      const p = params as Record<string, unknown>;
      const traceParent = p._traceParent as string | undefined;
      if (!traceParent) return;
      const traceState = p._traceState as string | undefined;
      const headers = new Headers();
      headers.set("traceparent", traceParent);
      if (traceState) headers.set("tracestate", traceState);
      const extractedCtx = tracing.extractContext(headers);
      // Strip internal framework trace-propagation fields so they don't leak
      // into the action's validated params.
      delete p._traceParent;
      delete p._traceState;
      this.parentCtxALS.enterWith(extractedCtx);
    });
  }

  /**
   * Wrap ioredis `sendCommand` on the main Redis client to emit a span per
   * command. Only the general-purpose client is instrumented; the subscription
   * client uses a different command flow for SUBSCRIBE/PSUBSCRIBE.
   */
  private instrumentRedis() {
    const client = api.redis?.redis;
    if (!client) return;
    const tracer = api.tracing.tracer;
    const originalSendCommand = client.sendCommand.bind(client);
    client.sendCommand = function (
      ...args: Parameters<typeof originalSendCommand>
    ) {
      const [command] = args;
      const commandName = (command as { name?: string }).name ?? "unknown";
      const span = tracer.startSpan(`redis.${commandName}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system.name": "redis",
          "db.operation.name": commandName,
        },
      });

      const result: unknown = originalSendCommand(...args);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).then(
          () => span.end(),
          (e: Error) => {
            span.recordException(e);
            span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
            span.end();
          },
        );
      } else {
        span.end();
      }
      return result;
    } as typeof client.sendCommand;
  }

  /**
   * Attach `@kubiks/otel-drizzle` instrumentation to the Drizzle client if
   * the `db` initializer has established one.
   */
  private instrumentDrizzle() {
    const db = (api as { db?: { db?: unknown } }).db?.db;
    if (!db) return;
    instrumentDrizzleClient(
      db as Parameters<typeof instrumentDrizzleClient>[0],
      {
        dbSystem: "postgresql",
        captureQueryText: true,
        maxQueryTextLength: 1000,
      },
    );
  }

  async stop() {
    // Reset tracing to no-ops and flush pending spans. `api.tracing` may be
    // undefined if initialize() didn't run (e.g., test fixtures that reload
    // the api singleton between files) — stop() must still flush pending
    // spans from a previous start().
    const ns = api.tracing;
    if (ns) {
      ns.enabled = false;
      ns.tracer = createNoopTracer();
      ns.extractContext = () => context.active();
      ns.injectContext = () => {};
    }

    if (this.tracerProvider) {
      try {
        await Promise.race([
          this.tracerProvider.shutdown(),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error("Span export timed out on shutdown")),
              config.tracing.spanShutdownTimeoutMs,
            ),
          ),
        ]);
      } catch (e) {
        logger.warn(`Error flushing spans on shutdown: ${e}`);
      }
      this.tracerProvider = undefined;
    }
  }
}

// --- No-op helpers used when tracing is disabled or stopped ---

/** No-op span that satisfies the OTel Span interface with zero overhead. */
const noopSpan: Span = {
  spanContext: () => ({
    traceId: "00000000000000000000000000000000",
    spanId: "0000000000000000",
    traceFlags: 0,
  }),
  setAttribute: () => noopSpan,
  setAttributes: () => noopSpan,
  addEvent: () => noopSpan,
  addLink: () => noopSpan,
  addLinks: () => noopSpan,
  setStatus: () => noopSpan,
  updateName: () => noopSpan,
  end: () => {},
  isRecording: () => false,
  recordException: () => {},
};

function createNoopTracer() {
  return {
    startSpan: (
      _name: string,
      _options?: SpanOptions,
      _context?: Context,
    ): Span => noopSpan,
    startActiveSpan: <F extends (span: Span) => ReturnType<F>>(
      _name: string,
      arg2: F | SpanOptions,
      arg3?: F | Context,
      arg4?: F,
    ): ReturnType<F> => {
      const fn = (arg4 ?? arg3 ?? arg2) as F;
      return fn(noopSpan) as ReturnType<F>;
    },
  };
}
