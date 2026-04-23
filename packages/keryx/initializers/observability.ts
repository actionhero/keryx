import {
  type Context,
  context,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";
import { Initializer } from "../classes/Initializer";

const namespace = "observability";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Observability["initialize"]>>;
  }
}

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

/**
 * Create a no-op tracer that returns no-op spans. Used when tracing is disabled
 * so callers don't need to check `enabled` before creating spans.
 */
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

/**
 * Core no-op stub: establishes `api.observability` with zero-overhead no-op
 * instruments so that web.ts, connection.ts, resque.ts, etc. can reference
 * `api.observability.*` safely whether or not the `@keryxjs/observability`
 * plugin is registered.
 *
 * To enable real OTel metrics and tracing, register the plugin:
 * ```ts
 * // config/plugins.ts
 * import { observabilityPlugin } from "@keryxjs/observability";
 * export default { plugins: [observabilityPlugin] };
 * ```
 */
export class Observability extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["actions", "connections"];
  }

  async initialize() {
    const noopAdd = (
      _value: number,
      _attributes?: Record<string, string>,
    ) => {};
    const noopRecord = (
      _value: number,
      _attributes?: Record<string, string>,
    ) => {};
    return {
      enabled: false,
      http: {
        requestsTotal: { add: noopAdd },
        requestDuration: { record: noopRecord },
        activeConnections: { add: noopAdd },
      },
      ws: { connections: { add: noopAdd }, messagesTotal: { add: noopAdd } },
      action: {
        executionsTotal: { add: noopAdd },
        duration: { record: noopRecord },
      },
      task: {
        enqueuedTotal: { add: noopAdd },
        executedTotal: { add: noopAdd },
        duration: { record: noopRecord },
      },
      collectMetrics: async () => "" as string,
      tracing: {
        enabled: false as boolean,
        tracer: createNoopTracer(),
        /**
         * Extract W3C trace context from incoming HTTP headers.
         * Returns the active context when tracing is disabled.
         *
         * @param headers - The incoming request `Headers` object.
         * @returns An OTel `Context` carrying the extracted trace parent.
         */
        extractContext: (_headers: Headers): Context => context.active(),
        /**
         * Inject W3C trace context into an outgoing carrier (e.g., task params).
         * No-op when tracing is disabled.
         *
         * @param carrier - A plain object to write `traceparent` / `tracestate` into.
         */
        injectContext: (_carrier: Record<string, string>): void => {},
      },
    };
  }
}
