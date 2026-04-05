import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { scaffoldProject } from "../util/scaffold";
import { upgradeProject } from "../util/upgrade";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keryx-upgrade-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function projectDir() {
  return path.join(tmpDir, "test-app");
}

async function scaffold() {
  await scaffoldProject("test-app", projectDir(), {
    includeDb: true,
    includeExample: true,
  });
}

describe("upgradeProject", () => {
  test("reports all files up to date after fresh scaffold", async () => {
    await scaffold();

    // Capture console output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await upgradeProject(projectDir(), { dryRun: false, force: true });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("up to date");
    expect(output).not.toContain("⚡ updated");
    expect(output).not.toContain("+ created");
    expect(output).toContain("23 already up to date");
  });

  test("detects and updates modified config file with --force", async () => {
    await scaffold();

    // Modify a config file
    const configPath = path.join(projectDir(), "config/process.ts");
    fs.writeFileSync(configPath, "// modified by user\n");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await upgradeProject(projectDir(), { dryRun: false, force: true });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("updated");
    expect(output).toContain("config/process.ts");

    // Verify the file was restored
    const restored = fs.readFileSync(configPath, "utf-8");
    expect(restored).not.toBe("// modified by user\n");
    expect(restored).toContain('from "keryx"');
  });

  test("--dry-run does not write files", async () => {
    await scaffold();

    // Modify a config file
    const configPath = path.join(projectDir(), "config/process.ts");
    const modified = "// modified by user\n";
    fs.writeFileSync(configPath, modified);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await upgradeProject(projectDir(), { dryRun: true, force: false });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("would update");

    // File should NOT have changed
    expect(fs.readFileSync(configPath, "utf-8")).toBe(modified);
  });

  test("creates missing framework files", async () => {
    await scaffold();

    // Delete a framework-owned file
    const statusPath = path.join(projectDir(), "actions/status.ts");
    fs.unlinkSync(statusPath);
    expect(fs.existsSync(statusPath)).toBe(false);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await upgradeProject(projectDir(), { dryRun: false, force: true });
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("created");
    expect(output).toContain("actions/status.ts");
    expect(fs.existsSync(statusPath)).toBe(true);
  });

  test("throws error in non-keryx directory", async () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir);

    expect(
      upgradeProject(emptyDir, { dryRun: false, force: false }),
    ).rejects.toThrow("No package.json found");
  });

  test("throws error when keryx is not a dependency", async () => {
    const dir = path.join(tmpDir, "no-keryx");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "test", dependencies: {} }),
    );

    expect(
      upgradeProject(dir, { dryRun: false, force: false }),
    ).rejects.toThrow('does not have "keryx" as a dependency');
  });
});
