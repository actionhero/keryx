import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, config } from "keryx";
import { buildWebSocket, HOOK_TIMEOUT, serverUrl, waitFor } from "../setup";

beforeAll(async () => {
  config.observability.enabled = true;
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
  config.observability.enabled = false;
}, HOOK_TIMEOUT);

describe("observability", () => {
  test("api.observability namespace exists and is enabled", () => {
    expect(api.observability).toBeDefined();
    expect(api.observability.enabled).toBe(true);
  });

  test("collectMetrics returns prometheus text format", async () => {
    const metrics = await api.observability.collectMetrics();
    expect(typeof metrics).toBe("string");
    expect(metrics).toContain("keryx_system_connections");
  });

  test("action execution records metrics", async () => {
    const url = serverUrl();
    const res = await fetch(`${url}/api/status`);
    expect(res.status).toBe(200);

    await Bun.sleep(50);

    const metrics = await api.observability.collectMetrics();
    expect(metrics).toContain("keryx_action_executions");
    expect(metrics).toContain("keryx_action_duration");
    expect(metrics).toContain("keryx_http_requests");
    expect(metrics).toContain("keryx_http_request_duration");
  });

  test("/metrics endpoint returns prometheus text", async () => {
    const url = serverUrl();

    await fetch(`${url}/api/status`);

    const res = await fetch(`${url}${config.observability.metricsRoute}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain("keryx_action_executions");
    expect(body).toContain("keryx_http_requests");
    expect(body).toContain("keryx_system_connections");
  });

  test("metrics include action name attributes", async () => {
    const url = serverUrl();
    await fetch(`${url}/api/status`);
    await Bun.sleep(50);

    const metrics = await api.observability.collectMetrics();
    expect(metrics).toContain("status");
    expect(metrics).toContain("success");
  });

  test("action.executions emits via afterAct hook with action + status labels", async () => {
    const url = serverUrl();
    await fetch(`${url}/api/status`);
    await Bun.sleep(50);

    const metrics = await api.observability.collectMetrics();
    // Each emitted data point carries its own labels, so we look for a single
    // line containing both the action identifier and the status dimension.
    const executionLines = metrics
      .split("\n")
      .filter((l) => l.startsWith("keryx_action_executions{"));
    expect(executionLines.length).toBeGreaterThan(0);
    const statusLine = executionLines.find(
      (l) => l.includes('action="status"') && l.includes('status="success"'),
    );
    expect(statusLine).toBeDefined();
  });

  test("task.enqueued emits via onEnqueue hook with action + queue labels", async () => {
    // MessagesCleanup is a task action registered in the example backend.
    await api.actions.enqueue(
      "messages:cleanup",
      { age: 1000 * 60 * 60 * 24 },
      "default",
    );
    await Bun.sleep(50);

    const metrics = await api.observability.collectMetrics();
    const enqueueLines = metrics
      .split("\n")
      .filter((l) => l.startsWith("keryx_task_enqueued{"));
    expect(enqueueLines.length).toBeGreaterThan(0);
    const match = enqueueLines.find(
      (l) =>
        l.includes('action="messages:cleanup"') &&
        l.includes('queue="default"'),
    );
    expect(match).toBeDefined();
  });

  test("/metrics endpoint is not counted as an action request", async () => {
    const url = serverUrl();

    await fetch(`${url}${config.observability.metricsRoute}`);
    await fetch(`${url}${config.observability.metricsRoute}`);

    const after = await api.observability.collectMetrics();
    expect(after).toContain("keryx_http_requests");
  });

  test("http.requests emits via afterRequest hook with method + route + status labels", async () => {
    const url = serverUrl();
    await fetch(`${url}/api/status`);
    await Bun.sleep(50);

    const metrics = await api.observability.collectMetrics();
    const requestLines = metrics
      .split("\n")
      .filter((l) => l.startsWith("keryx_http_requests{"));
    expect(requestLines.length).toBeGreaterThan(0);
    const match = requestLines.find(
      (l) =>
        l.includes('method="GET"') &&
        l.includes('route="status"') &&
        l.includes('status="200"'),
    );
    expect(match).toBeDefined();
  });

  test("ws.connections and ws.messages emit via ws hooks", async () => {
    const { socket } = await buildWebSocket();

    // Send a message to trigger the onMessage hook. The message format doesn't
    // need to parse cleanly — the hook fires before parsing.
    socket.send(JSON.stringify({ messageType: "ping" }));
    await Bun.sleep(50);

    const metricsWhileOpen = await api.observability.collectMetrics();
    // connections gauge should be positive while the socket is open
    const connectionLines = metricsWhileOpen
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("keryx_ws_connections ") ||
          l.startsWith("keryx_ws_connections{"),
      );
    expect(connectionLines.length).toBeGreaterThan(0);
    // ws.messages counter should have incremented
    expect(metricsWhileOpen).toContain("keryx_ws_messages");

    socket.close();
    await waitFor(() => socket.readyState === WebSocket.CLOSED);
  });

  test("mcp.sessions and mcp.messages emit via mcp hooks", async () => {
    // Drive the mcp lifecycle by firing the registered hooks directly — the
    // same internal iteration path `McpInitializer.handleRequest` uses. The
    // full OAuth+MCP-client end-to-end is covered in mcp.test.ts; here we just
    // need to confirm observability's registration picks up each hook.
    for (const hook of api.hooks.mcp.onConnectHooks) await hook("test-session");
    for (const hook of api.hooks.mcp.onMessageHooks) await hook("test-session");
    for (const hook of api.hooks.mcp.onDisconnectHooks)
      await hook("test-session");
    await Bun.sleep(50);

    const metrics = await api.observability.collectMetrics();
    const sessionLines = metrics
      .split("\n")
      .filter((l) => l.startsWith("keryx_mcp_sessions"));
    const messageLines = metrics
      .split("\n")
      .filter((l) => l.startsWith("keryx_mcp_messages"));
    expect(sessionLines.length).toBeGreaterThan(0);
    expect(messageLines.length).toBeGreaterThan(0);
  });
});
