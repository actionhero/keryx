import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const SCAFFOLD_TIMEOUT = 60_000;
const keryxTs = path.join(import.meta.dir, "..", "keryx.ts");
let tmpDir: string;
let projectDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keryx-cli-scaffold-"));

  const proc = Bun.spawn(
    ["bun", keryxTs, "new", "my-test-app", "--no-interactive"],
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

  projectDir = path.join(tmpDir, "my-test-app");
}, SCAFFOLD_TIMEOUT);

afterAll(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("keryx new (CLI integration)", () => {
  test("creates project directory", () => {
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(fs.statSync(projectDir).isDirectory()).toBe(true);
  });

  const expectedFiles = [
    "package.json",
    "index.ts",
    "keryx.ts",
    "tsconfig.json",
    ".env.example",
    ".gitignore",
    "migrations.ts",
    "config/index.ts",
    "schema/users.ts",
    "ops/UserOps.ts",
    "middleware/session.ts",
    "actions/user.ts",
    "actions/session.ts",
    "actions/me.ts",
  ];

  for (const file of expectedFiles) {
    test(`creates ${file}`, () => {
      expect(fs.existsSync(path.join(projectDir, file))).toBe(true);
    });
  }

  test("package.json is valid JSON with correct name", () => {
    const raw = fs.readFileSync(path.join(projectDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    expect(pkg.name).toBe("my-test-app");
    expect(pkg.dependencies.keryx).toMatch(/^\^/);
  });

  test("index.ts sets api.rootDir", () => {
    const content = fs.readFileSync(path.join(projectDir, "index.ts"), "utf-8");
    expect(content).toContain("api.rootDir = import.meta.dir");
  });

  test(".env.example contains expected vars", () => {
    const content = fs.readFileSync(
      path.join(projectDir, ".env.example"),
      "utf-8",
    );
    expect(content).toContain("WEB_SERVER_PORT=8080");
    expect(content).toContain("DATABASE_URL=");
    expect(content).toContain("REDIS_URL=");
    expect(content).toContain("PROCESS_NAME=my-test-app");
  });

  test("fails if directory already exists", async () => {
    const proc = Bun.spawn(
      ["bun", keryxTs, "new", "my-test-app", "--no-interactive"],
      {
        cwd: tmpDir,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
  });

  test(
    "-y flag works as shorthand for --no-interactive",
    async () => {
      const yTmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "keryx-cli-scaffold-y-"),
      );
      try {
        const proc = Bun.spawn(["bun", keryxTs, "new", "y-flag-app", "-y"], {
          cwd: yTmpDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(
            `keryx new -y failed with exit code ${exitCode}: ${stderr}`,
          );
        }

        const yProjectDir = path.join(yTmpDir, "y-flag-app");
        expect(fs.existsSync(yProjectDir)).toBe(true);
        expect(fs.existsSync(path.join(yProjectDir, "package.json"))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(yProjectDir, "migrations.ts"))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(yProjectDir, "actions/user.ts"))).toBe(
          true,
        );
        expect(
          fs.existsSync(path.join(yProjectDir, "actions/session.ts")),
        ).toBe(true);
        expect(fs.existsSync(path.join(yProjectDir, "actions/me.ts"))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(yProjectDir, "actions/hello.ts"))).toBe(
          false,
        );
      } finally {
        fs.rmSync(yTmpDir, { recursive: true, force: true });
      }
    },
    SCAFFOLD_TIMEOUT,
  );

  test(
    "-y flag respects --no-db and --no-example",
    async () => {
      const yTmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "keryx-cli-scaffold-y-opts-"),
      );
      try {
        const proc = Bun.spawn(
          [
            "bun",
            keryxTs,
            "new",
            "y-opts-app",
            "-y",
            "--no-db",
            "--no-example",
          ],
          {
            cwd: yTmpDir,
            stdout: "pipe",
            stderr: "pipe",
          },
        );

        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(
            `keryx new -y failed with exit code ${exitCode}: ${stderr}`,
          );
        }

        const yProjectDir = path.join(yTmpDir, "y-opts-app");
        expect(fs.existsSync(yProjectDir)).toBe(true);
        expect(fs.existsSync(path.join(yProjectDir, "migrations.ts"))).toBe(
          false,
        );
        expect(fs.existsSync(path.join(yProjectDir, "actions/hello.ts"))).toBe(
          false,
        );
      } finally {
        fs.rmSync(yTmpDir, { recursive: true, force: true });
      }
    },
    SCAFFOLD_TIMEOUT,
  );
});
