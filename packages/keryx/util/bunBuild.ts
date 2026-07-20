import { ErrorType, TypedError } from "../classes/TypedError";

/**
 * Run `bun build` in a **child process** and return its stdout.
 *
 * A child process is used rather than the in-process `Bun.build` API because once the
 * server has started, Bun has memory-mapped its loaded modules (e.g. zod) and the
 * in-process bundler fails to re-read them ("Unseekable reading file"). A fresh process
 * sidesteps that and is only paid once, at boot.
 *
 * @param args - Arguments passed to `bun build` (entrypoint plus flags).
 * @param label - Human description of what is being built, used in the error message.
 * @returns The build's stdout (the bundled output).
 * @throws {TypedError} When the build exits non-zero or produces no output (includes stderr).
 */
export async function spawnBunBuild(
  args: string[],
  label: string,
): Promise<string> {
  const proc = Bun.spawn([process.execPath, "build", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0 || output.trim().length === 0) {
    throw new TypedError({
      message: `Failed to build ${label}:\n${stderr || "no output"}`,
      type: ErrorType.SERVER_INITIALIZATION,
    });
  }

  return output;
}
