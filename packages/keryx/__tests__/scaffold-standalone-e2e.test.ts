import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * `keryx new --no-db --no-redis` must produce an app that boots and runs background
 * tasks with only Bun installed — no Postgres, no Redis server. CI runs this file in a
 * job with no service containers to prove it.
 */

const keryxTs = path.join(import.meta.dir, "..", "keryx.ts");
const keryxPkgDir = path.join(import.meta.dir, "..");
const E2E_TIMEOUT = 60_000;
const SERVER_PORT = 18766;

let tmpDir: string;
let projectDir: string;
let serverProc: Subprocess | undefined;
let serverStderrFile: string;

async function runCommand(args: string[], cwd: string) {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function readServerStderr(): string {
  if (!serverStderrFile || !fs.existsSync(serverStderrFile)) {
    return "(no stderr captured)";
  }
  return fs.readFileSync(serverStderrFile, "utf-8");
}

async function waitForServer(url: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `Server did not become ready at ${url} within ${timeoutMs}ms.\nServer stderr:\n${readServerStderr()}`,
  );
}

// A recurring task plus an action to read how many times it ran. The counter lives in
// (in-memory) Redis, so reading it back proves the scheduler, the worker and the web
// server all share the same in-process store.
const TICK_ACTION = `import { z } from "zod";
import { Action, api, HTTP_METHOD } from "keryx";

export class Tick implements Action {
  name = "tick";
  description = "Counts how many times the scheduler has run it";
  inputs = z.object({});
  task = { queue: "default", frequency: 200 };

  async run() {
    await api.redis.redis.incr("ticks");
  }
}

export class Ticks implements Action {
  name = "ticks";
  description = "Returns the tick count";
  inputs = z.object({});
  web = { route: "/ticks", method: HTTP_METHOD.GET };

  async run() {
    return { ticks: Number((await api.redis.redis.get("ticks")) ?? 0) };
  }
}
`;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keryx-standalone-e2e-"));
  serverStderrFile = path.join(tmpDir, "server-stderr.log");

  const scaffold = await runCommand(
    ["bun", keryxTs, "new", "standalone-app", "-y", "--no-db", "--no-redis"],
    tmpDir,
  );
  if (scaffold.exitCode !== 0) {
    throw new Error(
      `Scaffold failed (exit ${scaffold.exitCode}): ${scaffold.stderr}`,
    );
  }
  projectDir = path.join(tmpDir, "standalone-app");

  const pkgPath = path.join(projectDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  pkg.dependencies.keryx = `file:${keryxPkgDir}`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  const install = await runCommand(["bun", "install"], projectDir);
  if (install.exitCode !== 0) {
    throw new Error(
      `bun install failed (exit ${install.exitCode}): ${install.stderr}`,
    );
  }

  // The scaffolded .env.example is used as-is apart from the port.
  let envContent = fs.readFileSync(
    path.join(projectDir, ".env.example"),
    "utf-8",
  );
  envContent = envContent
    .replace(/^WEB_SERVER_PORT=.*/m, `WEB_SERVER_PORT=${SERVER_PORT}`)
    .replace(
      /^WEB_SERVER_PORT_TEST=.*/m,
      `WEB_SERVER_PORT_TEST=${SERVER_PORT}`,
    );
  fs.writeFileSync(path.join(projectDir, ".env"), envContent);
  fs.writeFileSync(path.join(projectDir, "actions", "tick.ts"), TICK_ACTION);

  // Clean env so the parent's DATABASE_URL / REDIS_URL can't leak in.
  const stderrFd = fs.openSync(serverStderrFile, "w");
  serverProc = Bun.spawn(["bun", "keryx.ts", "start"], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: stderrFd,
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      USER: os.userInfo().username,
      NODE_ENV: "test",
    },
  });

  await waitForServer(`http://localhost:${SERVER_PORT}/api/status`);
}, E2E_TIMEOUT);

afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited;
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("keryx new --no-db --no-redis — end-to-end", () => {
  test("does not scaffold database files", () => {
    expect(fs.existsSync(path.join(projectDir, "migrations.ts"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, "drizzle"))).toBe(false);
  });

  test("GET /api/status is healthy with the database disabled", async () => {
    const res = await fetch(`http://localhost:${SERVER_PORT}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      healthy: boolean;
      checks: Record<string, boolean | null>;
    };
    expect(body.healthy).toBe(true);
    expect(body.checks).toEqual({ database: null, redis: true });
  });

  test("the example hello action works", async () => {
    const res = await fetch(
      `http://localhost:${SERVER_PORT}/api/hello?name=Keryx`,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: string }).message).toBe(
      "Hello, Keryx!",
    );
  });

  test(
    "recurring tasks run on the in-memory scheduler",
    async () => {
      const start = Date.now();
      let ticks = 0;
      while (Date.now() - start < 20_000) {
        const res = await fetch(`http://localhost:${SERVER_PORT}/api/ticks`);
        ticks = ((await res.json()) as { ticks: number }).ticks;
        if (ticks >= 2) break;
        await Bun.sleep(200);
      }
      if (ticks < 2) {
        throw new Error(
          `recurring task ran ${ticks} time(s).\nServer stderr:\n${readServerStderr()}`,
        );
      }
    },
    E2E_TIMEOUT,
  );
});
