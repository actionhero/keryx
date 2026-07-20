import path from "node:path";
import { pathToFileURL } from "node:url";
import { api } from "../api";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import { spawnBunBuild } from "./bunBuild";

/**
 * The framework's default theme: the shared `--keryx-*` design tokens (palette, fonts,
 * radius) that every framework-rendered HTML surface inlines as its baseline. It is the
 * single source of truth for default branding — the OAuth authorization page and MCP App
 * shells both include it, and a user theme ({@link resolveThemeCss}) is inlined *after* it
 * so any token it redeclares wins by cascade order.
 *
 * This block defines tokens only (no layout/chrome), so surfaces share a vocabulary without
 * sharing page structure: the OAuth page styles itself with these tokens, and MCP App widgets
 * may reference them (e.g. `color: var(--keryx-color-primary)`).
 */
export const DEFAULT_THEME_CSS = `:root {
  --keryx-font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --keryx-color-primary: #2f5266;
  --keryx-color-primary-hover: #3a6a84;
  --keryx-color-accent: #e14e3a;
  --keryx-bg: linear-gradient(
    135deg,
    var(--keryx-color-primary) 0%,
    var(--keryx-color-primary-hover) 50%,
    var(--keryx-color-accent) 100%
  );
  --keryx-surface: #fff;
  --keryx-color-text: #555;
  --keryx-color-text-muted: #666;
  --keryx-color-border: #ddd;
  --keryx-radius: 12px;
}`;

/** Extensions bundled through Bun's CSS pipeline (`bun build`). */
const CSS_EXTENSIONS = new Set([".css"]);
/** Extensions dynamically imported for a default-exported CSS string. */
const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
/** Preprocessor extensions Bun cannot compile natively; surfaced with a targeted error. */
const PREPROCESSOR_EXTENSIONS = new Set([".scss", ".sass", ".less", ".styl"]);

/**
 * Memoized promise for the resolved theme CSS. Resolved once on first access (by whichever
 * of the OAuth or MCP initializers runs first) and reused for the process lifetime, so the
 * theme source is read/compiled exactly once regardless of which surfaces are enabled.
 */
let themePromise: Promise<string> | undefined;

/**
 * Resolve the app's shared theme CSS, compiling the configured source once and caching the
 * result. The returned string is inlined verbatim into every framework-rendered HTML surface
 * (the OAuth authorization page and MCP App shells).
 *
 * Dispatch by extension of {@link config.server.web.theme}:
 * - `.css` — bundled through `bun build` (resolves `@import`, minifies).
 * - `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs` — dynamically imported; the module's `default` export
 *   must be a CSS `string` (lets a theme compute CSS from design tokens).
 * - `.scss`/`.sass`/`.less`/`.styl` — not compiled natively by Bun; a {@link TypedError}
 *   directs you to precompile to `.css` or use a `.ts` entrypoint that returns a CSS string.
 *
 * @param themePath - Path to the theme source (defaults to `config.server.web.theme`). Empty
 *   returns `""` (no theme). Explicit for testability.
 * @param rootDir - Base directory relative paths resolve against (defaults to `api.rootDir`).
 * @returns The theme CSS string, or `""` when no theme is configured.
 * @throws {TypedError} When the path is missing, the extension is unsupported, a `.css`
 *   bundle fails, or a module entrypoint does not default-export a string.
 */
export function resolveThemeCss(
  themePath: string = config.server.web.theme,
  rootDir: string = api.rootDir,
): Promise<string> {
  if (!themePromise) themePromise = compileTheme(themePath, rootDir);
  return themePromise;
}

async function compileTheme(
  themePath: string,
  rootDir: string,
): Promise<string> {
  if (!themePath) return "";

  const absolutePath = path.isAbsolute(themePath)
    ? themePath
    : path.join(rootDir, themePath);

  if (!(await Bun.file(absolutePath).exists())) {
    throw new TypedError({
      message: `Theme CSS not found: "${absolutePath}" (config.server.web.theme)`,
      type: ErrorType.SERVER_INITIALIZATION,
    });
  }

  const extension = path.extname(absolutePath).toLowerCase();

  if (CSS_EXTENSIONS.has(extension)) {
    return spawnBunBuild(
      [absolutePath, "--minify"],
      `theme CSS "${absolutePath}"`,
    );
  }

  if (MODULE_EXTENSIONS.has(extension)) {
    const module = await import(pathToFileURL(absolutePath).href);
    const css = module.default;
    if (typeof css !== "string") {
      throw new TypedError({
        message: `Theme module "${absolutePath}" must default-export a CSS string (got ${typeof css})`,
        type: ErrorType.SERVER_INITIALIZATION,
      });
    }
    return css;
  }

  if (PREPROCESSOR_EXTENSIONS.has(extension)) {
    throw new TypedError({
      message: `Theme "${absolutePath}": Bun cannot compile "${extension}" natively. Precompile it to a .css file, or use a .ts entrypoint that default-exports a CSS string.`,
      type: ErrorType.SERVER_INITIALIZATION,
    });
  }

  throw new TypedError({
    message: `Theme "${absolutePath}": unsupported extension "${extension}". Use a .css file or a .ts/.js entrypoint that default-exports a CSS string.`,
    type: ErrorType.SERVER_INITIALIZATION,
  });
}

/**
 * Clear the memoized theme so the next {@link resolveThemeCss} call recompiles. Intended for
 * tests that exercise multiple theme sources within one process.
 */
export function resetThemeCache(): void {
  themePromise = undefined;
}
