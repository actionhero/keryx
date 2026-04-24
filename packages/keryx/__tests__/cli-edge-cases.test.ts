import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const keryxTs = path.join(import.meta.dir, "..", "keryx.ts");
let tmpDir: string;

async function runKeryx(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", keryxTs, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keryx-cli-edge-"));
});

afterAll(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("keryx new — existing directory", () => {
  test("fails without --force when directory exists and is non-empty", async () => {
    const projectName = "existing-nonempty";
    const target = path.join(tmpDir, projectName);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "README.md"), "# preexisting\n");

    const { exitCode, stderr } = await runKeryx(
      ["new", projectName, "-y"],
      tmpDir,
    );

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("already exists");
    // User file must be untouched
    expect(fs.readFileSync(path.join(target, "README.md"), "utf-8")).toBe(
      "# preexisting\n",
    );
    // No framework files should have been created
    expect(fs.existsSync(path.join(target, "keryx.ts"))).toBe(false);
    expect(fs.existsSync(path.join(target, "config"))).toBe(false);
  });

  test("fails without --force when directory exists but is empty", async () => {
    const projectName = "existing-empty";
    const target = path.join(tmpDir, projectName);
    fs.mkdirSync(target);

    const { exitCode, stderr } = await runKeryx(
      ["new", projectName, "-y"],
      tmpDir,
    );

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("already exists");
  });

  test("succeeds with --force into a non-empty directory, preserving user files", async () => {
    const projectName = "force-merge";
    const target = path.join(tmpDir, projectName);
    fs.mkdirSync(target);

    const readmeContent = "# my existing project\n\ndo not overwrite me\n";
    const userPkgContent = JSON.stringify(
      { name: "custom-name", version: "9.9.9", private: true },
      null,
      2,
    );
    fs.writeFileSync(path.join(target, "README.md"), readmeContent);
    fs.writeFileSync(path.join(target, "package.json"), userPkgContent);

    const { exitCode, stdout, stderr } = await runKeryx(
      ["new", projectName, "-y", "--force"],
      tmpDir,
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("scaffolding into existing directory");
    expect(stdout).toContain("⊘ skipped");
    expect(stdout).toContain("package.json");

    // User files preserved
    expect(fs.readFileSync(path.join(target, "README.md"), "utf-8")).toBe(
      readmeContent,
    );
    expect(fs.readFileSync(path.join(target, "package.json"), "utf-8")).toBe(
      userPkgContent,
    );

    // Framework files created
    expect(fs.existsSync(path.join(target, "keryx.ts"))).toBe(true);
    expect(fs.existsSync(path.join(target, "config/index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(target, "index.ts"))).toBe(true);
  });

  test("--force into an empty existing directory behaves like a normal scaffold", async () => {
    const projectName = "force-empty";
    const target = path.join(tmpDir, projectName);
    fs.mkdirSync(target);

    const { exitCode } = await runKeryx(
      ["new", projectName, "-y", "--force"],
      tmpDir,
    );

    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(target, "keryx.ts"))).toBe(true);
    expect(fs.existsSync(path.join(target, "package.json"))).toBe(true);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(target, "package.json"), "utf-8"),
    );
    expect(pkg.name).toBe(projectName);
  });
});

describe("keryx upgrade — idempotency", () => {
  let projectDir: string;

  beforeAll(async () => {
    const { exitCode, stderr } = await runKeryx(
      ["new", "idempotency-app", "-y"],
      tmpDir,
    );
    if (exitCode !== 0) {
      throw new Error(`keryx new failed: ${stderr}`);
    }
    projectDir = path.join(tmpDir, "idempotency-app");
  });

  test("running upgrade twice is a no-op on the second run", async () => {
    // First upgrade — should already be up to date from the fresh scaffold
    const first = await runKeryx(["upgrade", "--force"], projectDir);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Updated 0 file(s), created 0 file(s)");

    // Snapshot mtimes of every file in the project
    const snapshots = new Map<string, number>();
    for (const rel of walkFiles(projectDir)) {
      snapshots.set(rel, fs.statSync(path.join(projectDir, rel)).mtimeMs);
    }

    // Second upgrade — must not touch any file
    const second = await runKeryx(["upgrade", "--force"], projectDir);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Updated 0 file(s), created 0 file(s)");
    expect(second.stdout).not.toContain("⚡ updated");
    expect(second.stdout).not.toContain("+ created");

    // mtimes unchanged — strong proof the second run wrote nothing
    for (const [rel, mtime] of snapshots) {
      const after = fs.statSync(path.join(projectDir, rel)).mtimeMs;
      expect(after).toBe(mtime);
    }
  });

  test("upgrade after modifying then upgrading is idempotent on a third run", async () => {
    // Modify a framework file to force an update on the next run
    const configPath = path.join(projectDir, "config/process.ts");
    fs.writeFileSync(configPath, "// local tweak\n");

    // First upgrade — restores the file
    const restore = await runKeryx(["upgrade", "--force"], projectDir);
    expect(restore.exitCode).toBe(0);
    expect(restore.stdout).toContain("⚡ updated");

    // Snapshot after restore
    const mtimeAfterRestore = fs.statSync(configPath).mtimeMs;

    // Next upgrade — should be a no-op on the restored file
    const noop = await runKeryx(["upgrade", "--force"], projectDir);
    expect(noop.exitCode).toBe(0);
    expect(noop.stdout).toContain("Updated 0 file(s), created 0 file(s)");
    expect(fs.statSync(configPath).mtimeMs).toBe(mtimeAfterRestore);
  });
});
