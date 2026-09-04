import fs from "node:fs";
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

/**
 * Auto-discover exported *values* from `.ts`/`.tsx` files in a directory, keyed by export name.
 *
 * Where {@link globLoader} instantiates every exported class, this returns the exports
 * themselves. Use it for modules that export plain objects rather than classes — Drizzle
 * table definitions, for example, which cannot be constructed with `new`.
 *
 * @param searchDir - Absolute path, or a path resolved from `api.rootDir`, to scan. A missing
 * directory yields an empty registry instead of throwing, so optional project conventions
 * (like `schema/`) stay optional.
 * @param predicate - Type guard selecting which exports to keep; rejected exports are skipped,
 * which lets schema files freely export helpers, types, and constants alongside tables.
 * @returns Object mapping export name to value. When two files export the same name, whichever
 * the glob visits last wins.
 * @throws {TypedError} With `ErrorType.SERVER_INITIALIZATION` if a file fails to import.
 */
export async function globModuleExports<T>(
  searchDir: string,
  predicate: (value: unknown) => value is T,
) {
  const results: Record<string, T> = {};
  const dir = path.isAbsolute(searchDir)
    ? searchDir
    : path.join(api.rootDir, searchDir);

  if (!fs.existsSync(dir)) return results;

  const glob = new Glob("**/*.{ts,tsx}");

  for await (const file of glob.scan(dir)) {
    if (file.startsWith(".")) continue;

    const fullPath = path.join(dir, file);
    let modules: Record<string, unknown>;

    try {
      modules = (await import(fullPath)) as Record<string, unknown>;
    } catch (error) {
      throw new TypedError({
        message: `Error loading from ${dir} -  ${file} - ${error}`,
        type: ErrorType.SERVER_INITIALIZATION,
        cause: error,
      });
    }

    for (const [name, value] of Object.entries(modules)) {
      if (predicate(value)) results[name] = value;
    }
  }

  return results;
}
