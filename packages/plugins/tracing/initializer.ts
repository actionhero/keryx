import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { instrumentDrizzleClient } from "@kubiks/otel-drizzle";
import {
  type Attributes,
  type Context,
  type ContextManager,
  context,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  type SpanOptions,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { api, config, HTTP_METHOD, Initializer, logger } from "keryx";

const namespace = "tracing";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<TracingPlugin["initialize"]>>;
  }
}

/**
 * Per-request state used to update the HTTP span's name/attributes once the
 * action is resolved. The active OTel context (parent for child spans) lives
 * in `KeryxContextManager`, not here.
 */
interface RequestState {
  httpSpan: Span;
  method: string;
}

/**
 * True unless the named action set `tracing = false`. Unknown names stay traced.
 */
function isActionTraced(actionName: string | undefined): boolean {
  if (!actionName) return true;
  const action = api.actions.actions.find((a) => a.name === actionName);
  return action?.tracing !== false;
}

/**
 * Best-effort action name from an incoming HTTP request, used to skip the
 * HTTP span before session/DB work runs.
 */
function matchWebActionName(req: Request): string | undefined {
  try {
    const pathname = new URL(req.url).pathname;
    const pathToMatch = pathname.replace(
      new RegExp(config.server.web.apiRoute),
      "",
    );
    if (!pathToMatch) return undefined;
    const method = (req.method?.toUpperCase() ?? "GET") as HTTP_METHOD;
    return api.actions.router.match(pathToMatch, method)?.actionName;
  } catch {
    return undefined;
  }
}

/**
 * Sampler that records nothing while an action with `tracing = false` is
 * running, so Redis / Drizzle child spans don't leak as their own traces.
 * Delegates to an inner sampler the rest of the time.
 */
class SuppressibleSampler implements Sampler {
  constructor(
    private inner: Sampler,
    private isSuppressed: () => boolean,
  ) {}

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    if (this.isSuppressed()) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.inner.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      links,
    );
  }

  toString(): string {
    return `SuppressibleSampler(${this.inner.toString()})`;
  }
}

/**
 * OTel `ContextManager` backed by a single `AsyncLocalStorage<Context>` that
 * exposes a public `enterWith()`. This lets framework hooks (which have no
 * enclosing callback to wrap with `context.with(...)`) set the active context
 * for the remainder of the async task — so downstream Redis/Drizzle spans
 * created via `context.active()` inherit the action span as parent.
 *
 * The default `@opentelemetry/context-async-hooks` manager keeps its ALS
 * private and only exposes `with(ctx, fn)`, which is incompatible with a
 * hook-style API. Using a single shared ALS (instead of a side-car) keeps
 * `context.active()` and the plugin's own view of the active context in sync.
 */
export class KeryxContextManager implements ContextManager {
  private als = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.als.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const cb = thisArg == null ? fn : fn.bind(thisArg);
    return this.als.run(ctx, cb as (...args: A) => ReturnType<F>, ...args);
  }

  bind<T>(_ctx: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.als.disable();
    return this;
  }

  enterWith(ctx: Context): void {
    this.als.enterWith(ctx);
  }
}

/**
 * Build the `db.query.text` attribute for a Redis span: `"<command> <key>..."`
 * with keys-only (values never captured). Uses ioredis `Command.getKeys()`
 * to determine which args are keys; falls back to the command name alone if
 * the command isn't in `@ioredis/commands` or `getKeys()` throws.
 */
function buildRedisQueryText(command: unknown, commandName: string): string {
  try {
    const getKeys = (command as { getKeys?: () => Array<string | Buffer> })
      .getKeys;
    if (typeof getKeys !== "function") return commandName;
    const keys = getKeys.call(command);
    if (!Array.isArray(keys) || keys.length === 0) return commandName;
    return `${commandName} ${keys.map((k) => String(k)).join(" ")}`;
  } catch {
    return commandName;
  }
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
  private contextManager = new KeryxContextManager();

  /**
   * Plugin-owned AsyncLocalStorage for per-request trace context state. Set in
   * `beforeRequest` via `enterWith` so that `beforeAct` can update the HTTP span's
   * name with the resolved action route without needing to wrap subsequent hook
   * calls with `context.with`.
   */
  private requestALS = new AsyncLocalStorage<RequestState>();
  /**
   * When true, new spans (Redis, Drizzle, nested work) are not recorded.
   * Set at the request or job boundary for `tracing = false` and restored
   * when that request / job finishes.
   */
  private tracingSuppressedALS = new AsyncLocalStorage<boolean>();

  constructor() {
    super(namespace);
    // "redis" and "db" ensure the clients exist before we instrument them.
    this.dependsOn = [
      "hooks",
      "actions",
      "connections",
      "servers",
      "redis",
      "db",
    ];
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

    const sampler = new SuppressibleSampler(
      new TraceIdRatioBasedSampler(config.tracing.sampleRate),
      () => this.tracingSuppressedALS.getStore() === true,
    );

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

    // Shared context manager — a single ALS that both framework hooks
    // (via enterWith) and OTel (via context.active()) read from, so Redis
    // and Drizzle spans inherit the action span as parent automatically.
    // `context.disable()` first to force-override any manager already
    // registered (e.g. a test harness's own default manager) — otherwise
    // `setGlobalContextManager` no-ops and our enterWith writes go to an
    // ALS the rest of OTel ignores.
    context.disable();
    context.setGlobalContextManager(this.contextManager);

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
      ctx.metadata.otelPrevSuppressed =
        this.tracingSuppressedALS.getStore() === true;
      ctx.metadata.otelPrevContext = context.active();
      const actionName = matchWebActionName(req);
      if (!isActionTraced(actionName)) {
        ctx.metadata.otelTracingSuppressed = true;
        this.tracingSuppressedALS.enterWith(true);
        this.contextManager.enterWith(ROOT_CONTEXT);
        return;
      }
      // Traced requests must not inherit a leaked flag from a previous
      // opted-out request/job on this async context.
      this.tracingSuppressedALS.enterWith(false);

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
      // enterWith persists for the remainder of this async task, so beforeAct
      // can read requestALS (for the HTTP span reference) and context.active()
      // (for parent-context inheritance in child spans) without wrapping.
      this.requestALS.enterWith({ httpSpan, method });
      this.contextManager.enterWith(httpCtx);
    });

    api.hooks.web.afterRequest((_req, _res, ctx, outcome) => {
      try {
        if (ctx.metadata.otelTracingSuppressed) return;
        const httpSpan = ctx.metadata.otelSpan as Span | undefined;
        if (!httpSpan) return;
        if (!isActionTraced(outcome.actionName)) {
          // Don't export a transaction for an opted-out action. Leaving the
          // span un-ended means the processor never sees it.
          return;
        }
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
      } finally {
        const prevCtx = ctx.metadata.otelPrevContext as Context | undefined;
        this.contextManager.enterWith(prevCtx ?? ROOT_CONTEXT);
        this.tracingSuppressedALS.enterWith(
          ctx.metadata.otelPrevSuppressed === true,
        );
      }
    });

    api.hooks.actions.beforeAct((actionName, _params, connection, actCtx) => {
      const prevSuppressed = this.tracingSuppressedALS.getStore() === true;
      actCtx.metadata.otelPrevSuppressed = prevSuppressed;

      if (!isActionTraced(actionName) || prevSuppressed) {
        this.tracingSuppressedALS.enterWith(true);
        return;
      }

      const parentCtx = context.active();

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
      // Make the action span the active parent so Redis/Drizzle spans emitted
      // during the action (via context.active()) become children of it.
      this.contextManager.enterWith(trace.setSpan(parentCtx, actionSpan));
    });

    api.hooks.actions.afterAct(
      (_actionName, _params, _connection, actCtx, outcome) => {
        this.tracingSuppressedALS.enterWith(
          actCtx.metadata.otelPrevSuppressed === true,
        );
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
      if (this.tracingSuppressedALS.getStore()) return;
      const carrier: Record<string, string> = {};
      tracing.injectContext(carrier);
      if (!carrier.traceparent) return;
      const next: Record<string, unknown> = { ...inputs };
      next._traceParent = carrier.traceparent;
      if (carrier.tracestate) next._traceState = carrier.tracestate;
      return next;
    });

    api.hooks.resque.beforeJob((actionName, params, jobCtx) => {
      jobCtx.metadata.otelPrevSuppressed =
        this.tracingSuppressedALS.getStore() === true;
      jobCtx.metadata.otelPrevContext = context.active();
      const p = params as Record<string, unknown>;
      const traceParent = p._traceParent as string | undefined;
      const traceState = p._traceState as string | undefined;
      // Strip internal framework trace-propagation fields so they don't leak
      // into the action's validated params.
      delete p._traceParent;
      delete p._traceState;
      if (!isActionTraced(actionName)) {
        this.tracingSuppressedALS.enterWith(true);
        this.contextManager.enterWith(ROOT_CONTEXT);
        return;
      }
      this.tracingSuppressedALS.enterWith(false);
      if (!traceParent) return;
      const headers = new Headers();
      headers.set("traceparent", traceParent);
      if (traceState) headers.set("tracestate", traceState);
      const extractedCtx = tracing.extractContext(headers);
      this.contextManager.enterWith(extractedCtx);
    });

    api.hooks.resque.afterJob((_actionName, _params, jobCtx) => {
      const prevCtx = jobCtx.metadata.otelPrevContext as Context | undefined;
      this.contextManager.enterWith(prevCtx ?? ROOT_CONTEXT);
      this.tracingSuppressedALS.enterWith(
        jobCtx.metadata.otelPrevSuppressed === true,
      );
    });
  }

  /**
   * Wrap ioredis `sendCommand` on the main Redis client to emit a span per
   * command. Only the general-purpose client is instrumented; the subscription
   * client uses a different command flow for SUBSCRIBE/PSUBSCRIBE.
   *
   * Span `db.query.text` captures `<command> <key1> <key2>...` — keys only,
   * never values. ioredis's `Command.getKeys()` uses `@ioredis/commands`
   * metadata to pick out arg positions that are keys (e.g. for `MSET k1 v1
   * k2 v2` it returns `[k1, k2]`, and for `AUTH password` it returns `[]`).
   * That keeps secrets (AUTH passwords, SET values, session payloads) out of
   * trace attributes while preserving the key structure that makes Redis
   * traces useful for debugging.
   */
  private instrumentRedis() {
    const client = api.redis?.redis;
    if (!client) return;
    const tracer = api.tracing.tracer;
    const originalSendCommand = client.sendCommand.bind(client);
    const isSuppressed = () => this.tracingSuppressedALS.getStore() === true;
    client.sendCommand = function (
      ...args: Parameters<typeof originalSendCommand>
    ) {
      if (isSuppressed()) {
        return originalSendCommand(...args);
      }
      if (!trace.getSpan(context.active())) {
        return originalSendCommand(...args);
      }
      const [command] = args;
      const commandName = (command as { name?: string }).name ?? "unknown";
      const queryText = buildRedisQueryText(command, commandName);
      const span = tracer.startSpan(`redis.${commandName}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system.name": "redis",
          "db.operation.name": commandName,
          "db.query.text": queryText,
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
    // Reset tracing to no-ops and flush pending spans
    const ns = api.tracing;
    ns.enabled = false;
    ns.tracer = createNoopTracer();
    ns.extractContext = () => context.active();
    ns.injectContext = () => {};

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
