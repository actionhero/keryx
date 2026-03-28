import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { $ } from "bun";
import { api, config } from "keryx";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

// ---------------------------------------------------------------------------
// Thresholds — generous enough for slow GitHub Actions runners.
// These are "something is very wrong" guards, not tight regression detectors.
// Review the printed stats table for actual performance numbers.
// ---------------------------------------------------------------------------
const THRESHOLDS = {
  http: { iterations: 200, warmup: 5, p95ms: 500 },
  websocket: { iterations: 200, warmup: 5, p95ms: 500 },
  mcp: { iterations: 50, warmup: 2, p95ms: 2000 },
  cli: { iterations: 10, warmup: 1, p95ms: 10_000 },
};

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
interface Stats {
  min: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  rps: number;
  count: number;
}

function computeStats(durations: number[]): Stats {
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const count = sorted.length;
  const percentile = (p: number) => sorted[Math.ceil((p / 100) * count) - 1];
  return {
    min: sorted[0],
    avg: Math.round((sum / count) * 100) / 100,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    max: sorted[count - 1],
    rps: Math.round((count / (sum / 1000)) * 100) / 100,
    count,
  };
}

function printStats(name: string, stats: Stats, thresholdMs: number) {
  const fmt = (ms: number) => `${ms.toFixed(2)}ms`;
  console.log(`\n  Benchmark: ${name}`);
  console.log(`  Iterations: ${stats.count}`);
  console.log(
    `  Latency:  min=${fmt(stats.min)}  avg=${fmt(stats.avg)}  p50=${fmt(stats.p50)}  p95=${fmt(stats.p95)}  p99=${fmt(stats.p99)}  max=${fmt(stats.max)}`,
  );
  console.log(`  Throughput: ${stats.rps} req/s`);
  console.log(
    `  Threshold: p95 < ${thresholdMs}ms — ${stats.p95 <= thresholdMs ? "PASS" : "FAIL"}`,
  );
}

// ---------------------------------------------------------------------------
// OAuth helpers (for MCP transport)
// ---------------------------------------------------------------------------
function randomString(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function computeS256Challenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessToken(): Promise<string> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `bench-${unique}@example.com`;
  const name = `Bench ${unique}`;
  const password = "password123!";
  const redirectUri = "http://localhost:9999/callback";
  const base = serverUrl();

  const regRes = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "Benchmark Client",
    }),
  });
  const { client_id: clientId } = (await regRes.json()) as {
    client_id: string;
  };

  const codeVerifier = randomString(43);
  const codeChallenge = await computeS256Challenge(codeVerifier);

  const authRes = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      mode: "signup",
      name,
      email,
      password,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      response_type: "code",
      state: "bench",
    }).toString(),
    redirect: "manual",
  });
  const authHtml = await authRes.text();
  const metaMatch = authHtml.match(
    /<meta name="redirect-url" content="([^"]+)"\s*\/?>/,
  );
  const code = new URL(metaMatch![1]).searchParams.get("code")!;

  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }).toString(),
  });
  const { access_token } = (await tokenRes.json()) as {
    access_token: string;
  };
  return access_token;
}

// ---------------------------------------------------------------------------
// Benchmark suite
// ---------------------------------------------------------------------------
describe("transport benchmarks", () => {
  let url: string;
  let mcpClient: Client;

  beforeAll(async () => {
    config.server.mcp.enabled = true;
    config.rateLimit.enabled = false;
    config.server.web.websocket.maxMessagesPerSecond = 0; // disable for benchmarks
    await api.start();
    url = serverUrl();

    // Set up MCP client with OAuth
    const accessToken = await getAccessToken();
    const transport = new StreamableHTTPClientTransport(
      new URL(`${url}${config.server.mcp.route}`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      },
    );
    mcpClient = new Client({ name: "benchmark", version: "1.0.0" });
    await mcpClient.connect(transport);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await mcpClient?.close();
    await api.stop();
    config.server.mcp.enabled = false;
    config.rateLimit.enabled = true;
  }, HOOK_TIMEOUT);

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------
  test(
    "benchmark: http",
    async () => {
      const { iterations, warmup, p95ms } = THRESHOLDS.http;

      // Warmup
      for (let i = 0; i < warmup; i++) {
        await fetch(`${url}/status`);
      }

      // Measured iterations
      const durations: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const res = await fetch(`${url}/status`);
        const elapsed = performance.now() - start;
        expect(res.status).toBe(200);
        await res.json();
        durations.push(elapsed);
      }

      const stats = computeStats(durations);
      printStats("HTTP (GET /status)", stats, p95ms);
      expect(stats.p95).toBeLessThanOrEqual(p95ms);
    },
    { timeout: 60_000 },
  );

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------
  test(
    "benchmark: websocket",
    async () => {
      const { iterations, warmup, p95ms } = THRESHOLDS.websocket;
      let messageId = 0;

      // Create a fresh WebSocket connection for this benchmark
      const wsUrl = url
        .replace("https://", "wss://")
        .replace("http://", "ws://");
      const ws = new WebSocket(wsUrl);
      const pending = new Map<
        number,
        (value: Record<string, unknown>) => void
      >();
      ws.onmessage = (event) => {
        const parsed = JSON.parse(event.data);
        const resolve = pending.get(parsed.messageId);
        if (resolve) {
          pending.delete(parsed.messageId);
          resolve(parsed);
        }
      };
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", (e) => reject(e));
      });

      const sendAndWait = (id: number) =>
        new Promise<Record<string, unknown>>((resolve) => {
          pending.set(id, resolve);
          ws.send(
            JSON.stringify({
              messageType: "action",
              action: "status",
              messageId: id,
              params: {},
            }),
          );
        });

      // Warmup
      for (let i = 0; i < warmup; i++) {
        await sendAndWait(++messageId);
      }

      // Measured iterations
      const durations: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const id = ++messageId;
        const start = performance.now();
        const response = await sendAndWait(id);
        const elapsed = performance.now() - start;
        expect(response.error).toBeUndefined();
        durations.push(elapsed);
      }

      ws.close();

      const stats = computeStats(durations);
      printStats("WebSocket (action: status)", stats, p95ms);
      expect(stats.p95).toBeLessThanOrEqual(p95ms);
    },
    { timeout: 60_000 },
  );

  // -------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------
  test(
    "benchmark: mcp",
    async () => {
      const { iterations, warmup, p95ms } = THRESHOLDS.mcp;

      // Warmup
      for (let i = 0; i < warmup; i++) {
        await mcpClient.callTool({ name: "status", arguments: {} });
      }

      // Measured iterations
      const durations: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const result = await mcpClient.callTool({
          name: "status",
          arguments: {},
        });
        const elapsed = performance.now() - start;
        expect(result.isError).toBeFalsy();
        durations.push(elapsed);
      }

      const stats = computeStats(durations);
      printStats("MCP (callTool: status)", stats, p95ms);
      expect(stats.p95).toBeLessThanOrEqual(p95ms);
    },
    { timeout: 120_000 },
  );

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------
  test(
    "benchmark: cli",
    async () => {
      const { iterations, warmup, p95ms } = THRESHOLDS.cli;

      // Warmup
      for (let i = 0; i < warmup; i++) {
        await $`./keryx.ts status`.quiet();
      }

      // Measured iterations
      const durations: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        const { exitCode } = await $`./keryx.ts status`.quiet();
        const elapsed = performance.now() - start;
        expect(exitCode).toBe(0);
        durations.push(elapsed);
      }

      const stats = computeStats(durations);
      printStats("CLI (./keryx.ts status)", stats, p95ms);
      expect(stats.p95).toBeLessThanOrEqual(p95ms);
    },
    { timeout: 120_000 },
  );
});
