import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  writeFile as fsWriteFile,
  mkdir,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";
import mime from "mime";
import { glob as tinyGlob, globSync as tinyGlobSync } from "tinyglobby";

/**
 * Cross-runtime helpers so the framework runs on both Bun and Node.js.
 *
 * The HTTP/WebSocket transport lives in `servers/web.ts` (srvx + crossws); this
 * module covers the smaller runtime-specific primitives the rest of the
 * framework needs (file IO, globbing, hashing, sleeping, subprocesses).
 */

/** True when running under the Bun runtime (vs Node.js). */
export const isBun =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/**
 * Resolve after `ms` milliseconds. Cross-runtime replacement for `Bun.sleep`.
 *
 * @param ms - Milliseconds to wait.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find files matching a glob pattern, returning paths relative to `cwd`.
 * Cross-runtime replacement for `new Bun.Glob(pattern).scan(cwd)`.
 *
 * @param pattern - Glob pattern (e.g. `"**\/*.ts"`).
 * @param cwd - Directory to scan from. Returned paths are relative to it.
 * @returns Sorted array of matching file paths (POSIX separators).
 */
export async function glob(pattern: string, cwd: string): Promise<string[]> {
  return tinyGlob(pattern, { cwd, onlyFiles: true });
}

/**
 * Synchronous variant of {@link glob}. Replacement for `Bun.Glob.scanSync`.
 *
 * @param pattern - Glob pattern (e.g. `"**\/*.ts"`).
 * @param cwd - Directory to scan from. Returned paths are relative to it.
 * @returns Array of matching file paths (POSIX separators).
 */
export function globSync(pattern: string, cwd: string): string[] {
  return tinyGlobSync(pattern, { cwd, onlyFiles: true });
}

/**
 * Compute a hex-encoded SHA-256 digest over the concatenation of `parts`.
 * Cross-runtime replacement for `Bun.CryptoHasher("sha256")`.
 *
 * @param parts - Strings hashed in order (equivalent to repeated `.update()`).
 * @returns Hex-encoded digest.
 */
export function sha256Hex(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

/**
 * Read a UTF-8 text file. Cross-runtime replacement for `Bun.file(p).text()`.
 *
 * @param path - Absolute path to the file.
 */
export function readFileText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/**
 * Read and JSON-parse a file. Replacement for `Bun.file(p).json()`.
 *
 * @param path - Absolute path to the file.
 */
export async function readFileJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/**
 * Write a file, creating parent directories as needed. Cross-runtime
 * replacement for `Bun.write` (which also auto-creates parent dirs).
 *
 * @param path - Absolute path to write.
 * @param content - File contents.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, content);
}

/**
 * Test whether a path exists and is a regular file. Replacement for
 * `await Bun.file(p).exists()`, which (like this) reports `false` for
 * directories — callers rely on that to fall through to index.html handling.
 *
 * @param path - Absolute path to check.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Guess a MIME type from a file path/extension. Cross-runtime replacement for
 * `Bun.file(p).type`. Falls back to `application/octet-stream`.
 *
 * @param path - File path or name (only the extension is used).
 */
export function mimeType(path: string): string {
  return mime.getType(path) ?? "application/octet-stream";
}

/** Result of {@link spawnProcess}: exit code plus captured output. */
export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a subprocess to completion, capturing stdout/stderr as UTF-8 strings.
 * Cross-runtime replacement for `Bun.spawn` / the `Bun.$` shell.
 *
 * @param command - Executable to run.
 * @param args - Arguments passed to the executable.
 * @param opts.cwd - Working directory for the child process.
 * @returns The exit code and captured stdout/stderr.
 */
export function spawnProcess(
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * The package runner for the current runtime (`bunx` on Bun, `npx` on Node),
 * used to invoke locally-installed CLI binaries like `drizzle-kit`.
 */
export const packageRunner = isBun ? "bunx" : "npx";
