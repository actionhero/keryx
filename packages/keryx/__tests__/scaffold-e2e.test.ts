import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import fs from "fs";
import os from "os";
import path from "path";

const keryxTs = path.join(import.meta.dir, "..", "keryx.ts");
const keryxPkgDir = path.join(import.meta.dir, "..");
const E2E_TIMEOUT = 60_000;
const SERVER_PORT = 18765;
const REDIS_DB = 9;

let tmpDir: string;
let projectDir: string;
let serverProc: Subprocess | undefined;

async function runCommand(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? process.env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function waitForServer(
  url: string,
  stderrFile: string,
  timeoutMs: number = 30_000,
): Promise<void> {
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
  const stderr = fs.existsSync(stderrFile)
    ? fs.readFileSync(stderrFile, "utf-8")
    : "(no stderr captured)";
  throw new Error(
    `Server did not become ready at ${url} within ${timeoutMs}ms.\nServer stderr:\n${stderr}`,
  );
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keryx-e2e-"));
  const stderrFile = path.join(tmpDir, "server-stderr.log");

  // 1. Scaffold a new project with all defaults
  const scaffold = await runCommand(
    ["bun", keryxTs, "new", "test-app", "-y"],
    tmpDir,
  );
  if (scaffold.exitCode !== 0) {
    throw new Error(
      `Scaffold failed (exit ${scaffold.exitCode}): ${scaffold.stderr}`,
    );
  }

  projectDir = path.join(tmpDir, "test-app");

  // 2. Patch package.json to use local keryx package
  const pkgPath = path.join(projectDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  pkg.dependencies.keryx = `file:${keryxPkgDir}`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // 3. Install dependencies
  const install = await runCommand(["bun", "install"], projectDir);
  if (install.exitCode !== 0) {
    throw new Error(
      `bun install failed (exit ${install.exitCode}): ${install.stderr}`,
    );
  }

  // 4. Create .env with test-safe overrides (reuse keryx-test DB, dedicated Redis DB, unique port)
  //    In CI, DATABASE_URL_TEST is set with the correct credentials (e.g. postgres:postgres);
  //    locally, fall back to the current OS user with no password.
  const username = os.userInfo().username;
  const dbUrl =
    process.env.DATABASE_URL_TEST ??
    `postgres://${username}@localhost:5432/keryx-test`;
  let envContent = fs.readFileSync(
    path.join(projectDir, ".env.example"),
    "utf-8",
  );
  envContent = envContent.replace(
    /^WEB_SERVER_PORT=.*/m,
    `WEB_SERVER_PORT=${SERVER_PORT}`,
  );
  envContent = envContent.replace(
    /^WEB_SERVER_PORT_TEST=.*/m,
    `WEB_SERVER_PORT_TEST=${SERVER_PORT}`,
  );
  envContent = envContent.replace(
    /^DATABASE_URL=.*/m,
    `DATABASE_URL="${dbUrl}"`,
  );
  envContent = envContent.replace(
    /^DATABASE_URL_TEST=.*/m,
    `DATABASE_URL_TEST="${dbUrl}"`,
  );
  envContent = envContent.replace(
    /^REDIS_URL=.*/m,
    `REDIS_URL="redis://localhost:6379/${REDIS_DB}"`,
  );
  envContent = envContent.replace(
    /^REDIS_URL_TEST=.*/m,
    `REDIS_URL_TEST="redis://localhost:6379/${REDIS_DB}"`,
  );
  fs.writeFileSync(path.join(projectDir, ".env"), envContent);

  // 5. Start the server as a background process.
  //    Pass a clean env to prevent the parent's .env vars (e.g. WEB_SERVER_PORT_TEST=0)
  //    from leaking into the subprocess and overriding the child's .env file.
  const cleanEnv: Record<string, string> = {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    USER: username,
    NODE_ENV: "test",
  };
  const stderrFd = fs.openSync(stderrFile, "w");
  serverProc = Bun.spawn(["bun", "keryx.ts", "start"], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: stderrFd,
    env: cleanEnv,
  });

  // 6. Wait for the server to be ready
  await waitForServer(`http://localhost:${SERVER_PORT}/api/status`, stderrFile);
}, E2E_TIMEOUT);

afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("keryx new — end-to-end quickstart", () => {
  test("GET /api/status returns server info", async () => {
    const res = await fetch(`http://localhost:${SERVER_PORT}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("consumedMemoryMB");
    expect(body).toHaveProperty("pid");
  });

  test("sign up, sign in, and call authenticated endpoint", async () => {
    const uniqueSuffix = Date.now();
    const uniqueEmail = `e2e-${uniqueSuffix}@example.com`;
    const uniqueName = `E2E User ${uniqueSuffix}`;
    const password = "password123";

    // Sign up
    const signUpBody = new FormData();
    signUpBody.append("name", uniqueName);
    signUpBody.append("email", uniqueEmail);
    signUpBody.append("password", password);
    const signUpRes = await fetch(`http://localhost:${SERVER_PORT}/api/user`, {
      method: "PUT",
      body: signUpBody,
    });
    expect(signUpRes.status).toBe(200);
    const signUpData = (await signUpRes.json()) as {
      user: { id: number; email: string };
    };
    expect(signUpData.user.email).toBe(uniqueEmail);

    // Sign in
    const signInBody = new FormData();
    signInBody.append("email", uniqueEmail);
    signInBody.append("password", password);
    const signInRes = await fetch(
      `http://localhost:${SERVER_PORT}/api/session`,
      { method: "PUT", body: signInBody },
    );
    expect(signInRes.status).toBe(200);
    const cookie = signInRes.headers.get("set-cookie") ?? "";
    expect(cookie).toBeTruthy();

    // Call authenticated /me endpoint
    const meRes = await fetch(`http://localhost:${SERVER_PORT}/api/me`, {
      headers: { Cookie: cookie },
    });
    expect(meRes.status).toBe(200);
    const meData = (await meRes.json()) as { user: { email: string } };
    expect(meData.user.email).toBe(uniqueEmail);
  });

  test("GET /api/me without session returns 401", async () => {
    const res = await fetch(`http://localhost:${SERVER_PORT}/api/me`);
    expect(res.status).toBe(401);
  });
});
