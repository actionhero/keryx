import { Glob } from "bun";
import path from "path";
import { api } from "../api";
import { ErrorType, TypedError } from "../classes/TypedError";

/**
 * Auto-discover and instantiate all exported classes from `.ts`/`.tsx` files in a directory.
 * Files prefixed with `.` are skipped. Used to load actions, initializers, and servers.
 *
 * @param searchDir - Absolute path or relative path (resolved from `api.rootDir`) to scan.
 * @returns Array of instantiated class instances of type `T`.
 * @throws {TypedError} With `ErrorType.SERVER_INITIALIZATION` if any class fails to instantiate.
 */
export async function globLoader<T>(searchDir: string) {
  const results: T[] = [];
  const glob = new Glob("**/*.{ts,tsx}");
  const dir = path.isAbsolute(searchDir)
    ? searchDir
    : path.join(api.rootDir, searchDir);

  for await (const file of glob.scan(dir)) {
    if (file.startsWith(".")) continue;

    const fullPath = path.join(dir, file);
    const modules = (await import(fullPath)) as Record<string, unknown>;

    for (const [name, klass] of Object.entries(modules)) {
      // Skip non-class exports (constants, enums, functions)
      if (typeof klass !== "function" || klass.prototype === undefined) {
        continue;
      }

      try {
        const instance = new (klass as new () => T)();
        results.push(instance);
      } catch (error) {
        throw new TypedError({
          message: `Error loading from ${dir} -  ${name} - ${error}`,
          type: ErrorType.SERVER_INITIALIZATION,
          cause: error,
        });
      }
    }
  }

  return results;
}
