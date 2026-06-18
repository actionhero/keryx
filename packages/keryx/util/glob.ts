import path from "path";
import { api } from "../api";
import { ErrorType, TypedError } from "../classes/TypedError";
import { glob } from "./runtime";

/**
 * Auto-discover and instantiate all exported classes from source modules in a
 * directory. Used to load actions, initializers, and servers.
 *
 * Matches both TypeScript sources (`.ts`/`.tsx`, the dev/source layout under Bun
 * or Node + a TS loader) and compiled JavaScript (`.js`/`.mjs`/`.cjs`, the
 * built `dist/` layout a plain-Node consumer runs). Declaration files (`.d.ts`)
 * and dotfiles are skipped, and at most one module is loaded per basename so a
 * stray compiled `.js` sitting next to its `.ts` source can't double-instantiate.
 *
 * @param searchDir - Absolute path or relative path (resolved from `api.rootDir`) to scan.
 * @returns Array of instantiated class instances of type `T`.
 * @throws {TypedError} With `ErrorType.SERVER_INITIALIZATION` if any class fails to instantiate.
 */
export async function globLoader<T>(searchDir: string) {
  const results: T[] = [];
  const dir = path.isAbsolute(searchDir)
    ? searchDir
    : path.join(api.rootDir, searchDir);

  const seen = new Set<string>();
  for (const file of await glob("**/*.{ts,tsx,js,mjs,cjs}", dir)) {
    if (file.startsWith(".") || file.endsWith(".d.ts")) continue;

    // Collapse `foo.ts` / `foo.js` to a single load per basename.
    const base = file.replace(/\.(ts|tsx|js|mjs|cjs)$/, "");
    if (seen.has(base)) continue;
    seen.add(base);

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
