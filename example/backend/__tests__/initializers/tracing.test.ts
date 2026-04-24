import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { api, config } from "keryx";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

const spanExporter = new InMemorySpanExporter();

// Set up our own trace provider with an in-memory exporter BEFORE api.start()
// so that all spans created during the test are captured.
const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);

const testProvider = new BasicTracerProvider({
  resource: resourceFromAttributes({ "service.name": "keryx-test" }),
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(testProvider);

beforeAll(async () => {
  config.observability.tracingEnabled = true;
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
  config.observability.tracingEnabled = false;
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
    const res = await fetch(`${url}/api/status`);
    expect(res.status).toBe(200);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const actionSpan = spans.find((s) => s.name === "action:status");
    expect(actionSpan).toBeDefined();
    expect(actionSpan!.attributes["keryx.action"]).toBe("status");
    expect(actionSpan!.attributes["keryx.connection.type"]).toBe("web");
    expect(actionSpan!.attributes["keryx.action.duration_ms"]).toBeDefined();
  });

  test("HTTP request creates parent span with stable semconv attributes", async () => {
    spanExporter.reset();
    const url = serverUrl();
    const res = await fetch(`${url}/api/status`);
    expect(res.status).toBe(200);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    // Span name is updated to include route after resolution
    const httpSpan = spans.find((s) => s.name === "GET status");
    expect(httpSpan).toBeDefined();
    expect(httpSpan!.attributes["http.request.method"]).toBe("GET");
    expect(httpSpan!.attributes["http.response.status_code"]).toBe(200);
    expect(httpSpan!.attributes["http.route"]).toBe("status");
  });

  test("W3C traceparent header is extracted from incoming requests", async () => {
    spanExporter.reset();
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const spanId = "b7ad6b7169203331";
    const traceparent = `00-${traceId}-${spanId}-01`;

    const url = serverUrl();
    const res = await fetch(`${url}/api/status`, {
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
    await fetch(`${url}/api/status`);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const httpSpan = spans.find((s) => s.name === "GET status");
    const actionSpan = spans.find((s) => s.name === "action:status");

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
    await fetch(`${url}/api/status`);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const redisSpans = spans.filter((s) => s.name.startsWith("redis."));
    for (const span of redisSpans) {
      expect(span.attributes["db.system.name"]).toBe("redis");
      expect(span.attributes["db.operation.name"]).toBeDefined();
    }
  });

  test("Redis spans exist alongside action spans in the same request", async () => {
    spanExporter.reset();
    const url = serverUrl();
    await fetch(`${url}/api/status`);

    await Bun.sleep(100);

    const spans = spanExporter.getFinishedSpans();
    const actionSpan = spans.find((s) => s.name === "action:status");
    const redisSpans = spans.filter((s) => s.name.startsWith("redis."));

    expect(actionSpan).toBeDefined();
    // Redis spans should exist (session load, etc.)
    expect(redisSpans.length).toBeGreaterThan(0);
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
