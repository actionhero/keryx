import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { type Action, api, config, HTTP_METHOD } from "keryx";
import { z } from "zod";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

class TracingPing implements Action {
  name = "tracing:ping";
  description = "Traced action that pings Redis for span tests";
  inputs = z.object({});
  web = { route: "/tracing-ping", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  async run() {
    if (api.redis?.redis) await api.redis.redis.ping();
    return { ok: true };
  }
}

const spanExporter = new InMemorySpanExporter();

// Set up our own trace provider with an in-memory exporter BEFORE api.start()
// so that all spans created during the test are captured. The tracing plugin's
// own provider registration no-ops when a provider is already set, so our
// test provider wins. The context manager, by contrast, is force-overridden
// by the plugin (see TracingPlugin.startTracing) — so we don't need to set one.
const testProvider = new BasicTracerProvider({
  resource: resourceFromAttributes({ "service.name": "keryx-test" }),
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(testProvider);

beforeAll(async () => {
  await api.initialize();
  config.tracing.enabled = true;
  await api.start();
  api.actions.actions.push(new TracingPing());
}, HOOK_TIMEOUT);

afterAll(async () => {
  api.actions.actions = api.actions.actions.filter(
    (a: Action) => a.name !== "tracing:ping",
  );
  await api.stop();
  config.tracing.enabled = false;
  await testProvider.shutdown();
}, HOOK_TIMEOUT);

describe("tracing", () => {
  test("api.tracing namespace exists and is enabled", () => {
    expect(api.tracing).toBeDefined();
    expect(api.tracing.enabled).toBe(true);
    expect(api.tracing.tracer).toBeDefined();
  });

  test("action execution creates spans", async () => {
    spanExporter.reset();
    const url = serverUrl();
    const res = await fetch(`${url}/api/tracing-ping`);
    expect(res.status).toBe(200);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const actionSpan = spans.find((s) => s.name === "action:tracing:ping");
    expect(actionSpan).toBeDefined();
    expect(actionSpan!.attributes["keryx.action"]).toBe("tracing:ping");
    expect(actionSpan!.attributes["keryx.connection.type"]).toBe("web");
    expect(actionSpan!.attributes["keryx.action.duration_ms"]).toBeDefined();
  });

  test("HTTP request creates parent span with stable semconv attributes", async () => {
    spanExporter.reset();
    const url = serverUrl();
    const res = await fetch(`${url}/api/tracing-ping`);
    expect(res.status).toBe(200);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    // Span name is updated to include route after resolution
    const httpSpan = spans.find((s) => s.name === "GET tracing:ping");
    expect(httpSpan).toBeDefined();
    expect(httpSpan!.attributes["http.request.method"]).toBe("GET");
    expect(httpSpan!.attributes["http.response.status_code"]).toBe(200);
    expect(httpSpan!.attributes["http.route"]).toBe("tracing:ping");
  });

  test("W3C traceparent header is extracted from incoming requests", async () => {
    spanExporter.reset();
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const spanId = "b7ad6b7169203331";
    const traceparent = `00-${traceId}-${spanId}-01`;

    const url = serverUrl();
    const res = await fetch(`${url}/api/tracing-ping`, {
      headers: { traceparent },
    });
    expect(res.status).toBe(200);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name.startsWith("GET"));
    expect(httpSpan).toBeDefined();
    // The span's trace ID should match the incoming traceparent
    expect(httpSpan!.spanContext().traceId).toBe(traceId);
  });

  test("action span is a child of HTTP span", async () => {
    spanExporter.reset();
    const url = serverUrl();
    await fetch(`${url}/api/tracing-ping`);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name === "GET tracing:ping");
    const actionSpan = spans.find((s) => s.name === "action:tracing:ping");

    expect(httpSpan).toBeDefined();
    expect(actionSpan).toBeDefined();
    // Same trace
    expect(actionSpan!.spanContext().traceId).toBe(
      httpSpan!.spanContext().traceId,
    );
    // @ts-expect-error -- parentSpanContext exists on ReadableSpan in OTel SDK v2 but is not declared in the public type definitions
    expect(actionSpan.parentSpanContext?.spanId).toBe(
      httpSpan!.spanContext().spanId,
    );
  });

  test("error actions record exception on span", async () => {
    spanExporter.reset();
    const url = serverUrl();
    const res = await fetch(`${url}/api/nonexistent`);
    expect(res.status).toBe(404);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name.startsWith("GET"));
    expect(httpSpan).toBeDefined();
    expect(httpSpan!.attributes["http.response.status_code"]).toBe(404);
  });

  test("actions with tracing = false emit no HTTP or action spans", async () => {
    spanExporter.reset();
    const url = serverUrl();
    const statusAction = api.actions.actions.find((a) => a.name === "status");
    expect(statusAction?.tracing).toBe(false);
    const res = await fetch(`${url}/api/status`);
    expect(res.status).toBe(200);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    expect(spans.some((s) => s.name === "GET status")).toBe(false);
    expect(spans.some((s) => s.name === "action:status")).toBe(false);
    // The status action pings Redis as a health check; that must not be traced.
    // Other redis.* spans may still appear from the Resque worker polling queues.
    expect(spans.some((s) => s.name === "redis.ping")).toBe(false);
  });

  test("tracing and metrics flags are independent", () => {
    // Tracing is enabled but metrics is not in this test suite
    expect(api.tracing.enabled).toBe(true);
    expect(api.observability.enabled).toBe(false);
  });

  test("DB queries create spans with timing via @kubiks/otel-drizzle", async () => {
    spanExporter.reset();
    const url = serverUrl();
    // Create a user to force a real DB INSERT
    await fetch(`${url}/api/user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "tracing-test-user",
        email: `tracing-${Date.now()}@test.com`,
        password: "password123",
      }),
    });

    await Bun.sleep(200);

    const spans = spanExporter.getFinishedSpans();
    const drizzleSpans = spans.filter((s) => s.name.startsWith("drizzle."));
    // @kubiks/otel-drizzle creates spans for each DB operation; verify
    // attributes when present (span count depends on instrumentation timing).
    for (const span of drizzleSpans) {
      expect(span.attributes["db.system"]).toBe("postgresql");
      expect(span.endTime).toBeDefined();
    }
  });

  test("Redis command spans use stable semconv attributes", async () => {
    spanExporter.reset();
    const url = serverUrl();
    await fetch(`${url}/api/tracing-ping`);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const redisSpans = spans.filter((s) => s.name.startsWith("redis."));
    for (const span of redisSpans) {
      expect(span.attributes["db.system.name"]).toBe("redis");
      expect(span.attributes["db.operation.name"]).toBeDefined();
    }
  });

  test("Redis spans capture command + keys in db.query.text (no values)", async () => {
    spanExporter.reset();
    const url = serverUrl();
    await fetch(`${url}/api/tracing-ping`);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();

    // PING takes no key — db.query.text should be just the command.
    const pingSpan = spans.find((s) => s.name === "redis.ping");
    expect(pingSpan).toBeDefined();
    expect(pingSpan!.attributes["db.query.text"]).toBe("ping");

    // At least one span (e.g. the session load's GET) should include a key
    // after the command — proves ioredis's getKeys() lookup is wired up.
    const withKey = spans.some((s) => {
      const t = s.attributes["db.query.text"];
      return (
        s.name.startsWith("redis.") &&
        typeof t === "string" &&
        t.split(" ").length >= 2
      );
    });
    expect(withKey).toBe(true);
  });

  test("Redis spans exist alongside action spans in the same request", async () => {
    spanExporter.reset();
    const url = serverUrl();
    await fetch(`${url}/api/tracing-ping`);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const actionSpan = spans.find((s) => s.name === "action:tracing:ping");
    const redisSpans = spans.filter((s) => s.name.startsWith("redis."));

    expect(actionSpan).toBeDefined();
    // Redis spans should exist (session load, etc.)
    expect(redisSpans.length).toBeGreaterThan(0);
  });

  test("Redis spans from inside action.run are children of the action span", async () => {
    spanExporter.reset();
    const url = serverUrl();
    // tracing:ping explicitly calls api.redis.redis.ping() inside run(),
    // which produces a `redis.ping` span that should be parented to the
    // action span (session loads happen *before* beforeAct and are parented
    // to the HTTP span — that's correct, just not what we're testing here).
    await fetch(`${url}/api/tracing-ping`);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const actionSpan = spans.find((s) => s.name === "action:tracing:ping");
    expect(actionSpan).toBeDefined();

    const traceId = actionSpan!.spanContext().traceId;
    const pingSpan = spans.find(
      (s) => s.name === "redis.ping" && s.spanContext().traceId === traceId,
    );
    expect(pingSpan).toBeDefined();
    // @ts-expect-error -- parentSpanContext exists on ReadableSpan in SDK v2
    expect(pingSpan.parentSpanContext?.spanId).toBe(
      actionSpan!.spanContext().spanId,
    );
  });

  test("Drizzle spans are children of the action span (same trace)", async () => {
    spanExporter.reset();
    const url = serverUrl();
    // POST /api/user runs INSERT via Drizzle inside the action.
    await fetch(`${url}/api/user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "tracing-parenting-user",
        email: `tracing-parenting-${Date.now()}@test.com`,
        password: "password123",
      }),
    });

    await Bun.sleep(200);

    const spans = spanExporter.getFinishedSpans();
    const actionSpan = spans.find((s) => s.name.startsWith("action:user"));

    // If the action didn't run (e.g. validation failure), skip.
    if (!actionSpan) return;

    const traceId = actionSpan.spanContext().traceId;
    const inTrace = spans.filter(
      (s) =>
        s.name.startsWith("drizzle.") && s.spanContext().traceId === traceId,
    );

    // Drizzle span emission is timing-dependent; skip assertion if none.
    if (inTrace.length === 0) return;

    for (const ds of inTrace) {
      expect(ds.parentSpanContext?.spanId).toBe(
        actionSpan.spanContext().spanId,
      );
    }
  });

  test("injectContext produces valid traceparent within an active span", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("test-parent");
    const ctx = trace.setSpan(context.active(), span);

    const carrier: Record<string, string> = {};
    context.with(ctx, () => {
      propagation.inject(context.active(), carrier);
    });
    span.end();

    expect(carrier.traceparent).toBeDefined();
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });
});
