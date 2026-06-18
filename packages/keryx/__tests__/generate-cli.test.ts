import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const keryxTs = path.join(import.meta.dir, "..", "keryx.ts");
let tmpDir: string;
let projectDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keryx-cli-generate-"));

  // Scaffold a project first so we have a valid rootDir
  const proc = Bun.spawn(
    ["bun", keryxTs, "new", "gen-test-app", "--no-interactive"],
    {
      cwd: tmpDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`keryx new failed with exit code ${exitCode}: ${stderr}`);
  }

  projectDir = path.join(tmpDir, "gen-test-app");
});

afterAll(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function runGenerate(
  ...args: string[]
): ReturnType<typeof Bun.spawn> & { exited: Promise<number> } {
  return Bun.spawn(["bun", keryxTs, "generate", ...args], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("keryx generate action", () => {
  test("generates a simple action", async () => {
    const proc = runGenerate("action", "greet");
    expect(await proc.exited).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "actions/greet.ts"))).toBe(true);
    expect(
      fs.existsSync(path.join(projectDir, "__tests__/actions/greet.test.ts")),
    ).toBe(true);

    const content = fs.readFileSync(
      path.join(projectDir, "actions/greet.ts"),
      "utf-8",
    );
    expect(content).toContain('name = "greet"');
    expect(content).toContain("class Greet implements Action");
    expect(content).toContain('route: "/greet"');
  });

  test("generates a namespaced action with nested directory", async () => {
    const proc = runGenerate("action", "user:delete");
    expect(await proc.exited).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "actions/user/delete.ts"))).toBe(
      true,
    );

    const content = fs.readFileSync(
      path.join(projectDir, "actions/user/delete.ts"),
      "utf-8",
    );
    expect(content).toContain('name = "user:delete"');
    expect(content).toContain("class UserDelete implements Action");
    expect(content).toContain('route: "/user/delete"');
  });
});

describe("keryx generate initializer", () => {
  test("generates an initializer", async () => {
    const proc = runGenerate("initializer", "cache");
    expect(await proc.exited).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "initializers/cache.ts"))).toBe(
      true,
    );

    const content = fs.readFileSync(
      path.join(projectDir, "initializers/cache.ts"),
      "utf-8",
    );
    expect(content).toContain('const namespace = "cache"');
    expect(content).toContain("class Cache extends Initializer");
    expect(content).toContain('declare module "keryx"');
  });
});

describe("keryx generate middleware", () => {
  test("generates middleware", async () => {
    const proc = runGenerate("middleware", "auth");
    expect(await proc.exited).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "middleware/auth.ts"))).toBe(
      true,
    );

    const content = fs.readFileSync(
      path.join(projectDir, "middleware/auth.ts"),
      "utf-8",
    );
    expect(content).toContain("export const AuthMiddleware: ActionMiddleware");
  });
});

describe("keryx generate channel", () => {
  test("generates a channel", async () => {
    const proc = runGenerate("channel", "notifications");
    expect(await proc.exited).toBe(0);
    expect(
      fs.existsSync(path.join(projectDir, "channels/notifications.ts")),
    ).toBe(true);

    const content = fs.readFileSync(
      path.join(projectDir, "channels/notifications.ts"),
      "utf-8",
    );
    expect(content).toContain("class NotificationsChannel extends Channel");
    expect(content).toContain('name: "notifications"');
  });
});

describe("keryx generate ops", () => {
  test("generates an ops file", async () => {
    const proc = runGenerate("ops", "MessageOps");
    expect(await proc.exited).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "ops/MessageOps.ts"))).toBe(
      true,
    );

    const content = fs.readFileSync(
      path.join(projectDir, "ops/MessageOps.ts"),
      "utf-8",
    );
    expect(content).toContain("MessageOps");
  });
});

describe("keryx generate plugin", () => {
  test("generates a plugin manifest", async () => {
    const proc = runGenerate("plugin", "analytics");
    expect(await proc.exited).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "plugins/analytics.ts"))).toBe(
      true,
    );
    expect(
      fs.existsSync(
        path.join(projectDir, "__tests__/plugins/analytics.test.ts"),
      ),
    ).toBe(true);

    const content = fs.readFileSync(
      path.join(projectDir, "plugins/analytics.ts"),
      "utf-8",
    );
    expect(content).toContain("export const AnalyticsPlugin: KeryxPlugin");
    expect(content).toContain('name: "analytics"');
    expect(content).toContain('version: "0.1.0"');
  });
});

describe("keryx generate options", () => {
  test("--dry-run does not create files", async () => {
    const proc = runGenerate("action", "dry-run-test", "--dry-run");
    expect(await proc.exited).toBe(0);
    expect(
      fs.existsSync(path.join(projectDir, "actions/dry-run-test.ts")),
    ).toBe(false);

    const stdout = await new Response(proc.stdout as ReadableStream).text();
    expect(stdout).toContain("Would create:");
  });

  test("--no-test skips test file generation", async () => {
    const proc = runGenerate("action", "no-test-action", "--no-test");
    expect(await proc.exited).toBe(0);
    expect(
      fs.existsSync(path.join(projectDir, "actions/no-test-action.ts")),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(projectDir, "__tests__/actions/no-test-action.test.ts"),
      ),
    ).toBe(false);
  });

  test("fails on existing file without --force", async () => {
    // First generate
    const proc1 = runGenerate("action", "duplicate", "--no-test");
    expect(await proc1.exited).toBe(0);

    // Try again — should fail
    const proc2 = runGenerate("action", "duplicate", "--no-test");
    expect(await proc2.exited).toBe(1);

    const stderr = await new Response(proc2.stderr as ReadableStream).text();
    expect(stderr).toContain("already exists");
  });

  test("--force overwrites existing file", async () => {
    const proc = runGenerate("action", "duplicate", "--force", "--no-test");
    expect(await proc.exited).toBe(0);
  });

  test("fails on invalid type", async () => {
    const proc = runGenerate("widget", "foo");
    expect(await proc.exited).toBe(1);

    const stderr = await new Response(proc.stderr as ReadableStream).text();
    expect(stderr).toContain('Unknown generator type "widget"');
  });
});

describe("keryx g alias", () => {
  test("g alias works for generate", async () => {
    const proc = Bun.spawn(["bun", keryxTs, "g", "action", "alias-test"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "actions/alias-test.ts"))).toBe(
      true,
    );
  });
});
