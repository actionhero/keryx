import { fileURLToPath } from "node:url";
import { api, logger } from "../api";
import type { Action, McpUiConfig } from "../classes/Action";
import { ErrorType, TypedError } from "../classes/TypedError";
import { spawnBunBuild } from "./bunBuild";
import { DEFAULT_THEME_CSS, resolveThemeCss } from "./theme";

/**
 * Default self-contained HTML shell for an MCP App declared with only `mcp.ui.client`.
 * Provides a `<div id="root">` (the element {@link "@keryxjs/mcp-app"!mountMcpApp} targets
 * by default) and an empty module script the bundled client is inlined into.
 */
export const DEFAULT_MCP_APP_SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      ${DEFAULT_THEME_CSS}
      :root { color-scheme: light dark; font-family: var(--keryx-font-family); }
      body { margin: 0; padding: 16px; }
      /* MCP_APP_THEME */
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module"></script>
  </body>
</html>
`;

/** Placeholder comment a shell may use to mark where the bundled client is inlined. */
const COMMENT_PLACEHOLDER = "/* MCP_APP_CLIENT */";
/** Placeholder comment a shell may use to mark where the shared theme CSS is inlined. */
const THEME_PLACEHOLDER = "/* MCP_APP_THEME */";
/** Matches an empty `<script type="module">` tag (the preferred, declarative injection point). */
const EMPTY_MODULE_SCRIPT = /<script\s+type=["']module["']>\s*<\/script>/;
/**
 * Matches the sequences that let bundled JS prematurely terminate (or corrupt) the inline
 * `<script>` element it is embedded in: a closing `</script` tag (case-insensitive) and an
 * `<!--` comment opener (which flips the HTML parser into "script data escaped" state).
 */
const SCRIPT_BREAKOUT = /<(\/script|!--)/gi;

/**
 * Make bundled JS safe to inline inside an HTML `<script>` element. HTML parsers end a
 * script at the first literal `</script>` (and `<!--` can start an escaped state that hides
 * a later real `</script>`), so an unescaped bundle terminates the tag early and the rest
 * renders as page text. Backslash-escaping the `<` neutralizes both without changing JS
 * semantics: `<\/script` is identical to `</script` in every JS context, and `<\!--` is an
 * identity escape inside the string literals where `<!--` appears in minified bundles.
 *
 * @param script - The bundled client JS to embed.
 * @returns The JS with `</script`/`<!--` sequences backslash-escaped.
 */
export function escapeScriptForInlineHtml(script: string): string {
  return script.replace(
    SCRIPT_BREAKOUT,
    (_match, tail: string) => `<\\${tail}`,
  );
}

/** Resolved HTML per UI action, computed once at boot by {@link resolveMcpAppUiResources}. */
const resolvedUiHtml = new Map<Action, string>();

/**
 * Bundle a browser entrypoint into a single minified ESM string.
 *
 * @param client - Path or `file:` URL to the browser entrypoint (`.ts`/`.tsx`/`.js`).
 * @returns The minified, bundled client script.
 * @throws {TypedError} When the bundle fails (message includes the bundler's stderr).
 */
export async function bundleMcpAppClient(
  client: string | URL,
): Promise<string> {
  const entrypoint =
    client instanceof URL
      ? fileURLToPath(client)
      : client.startsWith("file:")
        ? fileURLToPath(new URL(client))
        : client;

  return spawnBunBuild(
    [entrypoint, "--target=browser", "--format=esm", "--minify"],
    `MCP App client "${entrypoint}"`,
  );
}

/**
 * Inline a bundled client script into an HTML shell. Prefers an empty
 * `<script type="module"></script>`, then a `MCP_APP_CLIENT` placeholder comment,
 * then just before `</body>`, and finally appends as a last resort.
 *
 * The bundle is HTML-escaped ({@link escapeScriptForInlineHtml}) first so `</script>`
 * sequences inside the JS cannot close the module tag early. Uses replacer functions so
 * `$`-sequences in the bundled JS are inserted literally.
 */
function injectClientScript(shell: string, rawScript: string): string {
  const script = escapeScriptForInlineHtml(rawScript);
  if (EMPTY_MODULE_SCRIPT.test(shell)) {
    return shell.replace(
      EMPTY_MODULE_SCRIPT,
      () => `<script type="module">${script}</script>`,
    );
  }
  if (shell.includes(COMMENT_PLACEHOLDER)) {
    return shell.replace(COMMENT_PLACEHOLDER, () => script);
  }
  const scriptTag = `<script type="module">${script}</script>`;
  if (shell.includes("</body>")) {
    return shell.replace("</body>", () => `${scriptTag}</body>`);
  }
  return `${shell}${scriptTag}`;
}

/**
 * Inline the shared theme CSS into an HTML shell. Prefers a `MCP_APP_THEME` placeholder
 * comment (so custom shells position the theme precisely), then inserts a `<style>` block
 * before `</head>`, then before `</body>`, and finally appends as a last resort. When the
 * theme is empty and no placeholder is present, the shell is returned unchanged.
 *
 * Uses a replacer function so `$`-sequences in the CSS are inserted literally.
 */
export function injectThemeCss(shell: string, themeCss: string): string {
  if (shell.includes(THEME_PLACEHOLDER)) {
    return shell.replace(THEME_PLACEHOLDER, () => themeCss);
  }
  if (!themeCss) return shell;
  const styleTag = `<style>${themeCss}</style>`;
  if (shell.includes("</head>")) {
    return shell.replace("</head>", () => `${styleTag}</head>`);
  }
  if (shell.includes("</body>")) {
    return shell.replace("</body>", () => `${styleTag}</body>`);
  }
  return `${shell}${styleTag}`;
}

/**
 * Compute the served HTML for an MCP App's `mcp.ui` config.
 *
 * - With `client`: bundles it and inlines the result into `html` (or {@link DEFAULT_MCP_APP_SHELL}).
 * - With only `html`: returns it as-is.
 *
 * In both cases the app's shared theme CSS ({@link resolveThemeCss}) is inlined — into the
 * `MCP_APP_THEME` placeholder when present, otherwise as a `<style>` block. When no theme is
 * configured, custom `html` shells are returned byte-for-byte verbatim.
 *
 * @param ui - The action's `mcp.ui` config.
 * @returns The self-contained HTML to serve as the `ui://` resource.
 * @throws {TypedError} When neither `client` nor `html` is set, or bundling fails.
 */
export async function resolveMcpAppHtml(ui: McpUiConfig): Promise<string> {
  const themeCss = await resolveThemeCss();
  if (ui.client) {
    const script = await bundleMcpAppClient(ui.client);
    const shell = injectClientScript(ui.html ?? DEFAULT_MCP_APP_SHELL, script);
    return injectThemeCss(shell, themeCss);
  }
  if (ui.html !== undefined) return injectThemeCss(ui.html, themeCss);
  throw new TypedError({
    message: "mcp.ui requires either `client` or `html` to be set",
    type: ErrorType.ACTION_VALIDATION,
  });
}

/**
 * Resolve and cache the HTML for every action declaring `mcp.ui`. Called once at MCP
 * server boot so per-session resource registration reads pre-built HTML (and so a bundle
 * error fails startup fast rather than the first tool call).
 *
 * @throws {TypedError} When any UI action's HTML cannot be resolved (e.g. a bundle error).
 */
export async function resolveMcpAppUiResources(): Promise<void> {
  resolvedUiHtml.clear();
  let count = 0;
  for (const action of api.actions.actions) {
    const ui = action.mcp?.ui;
    if (!ui) continue;
    resolvedUiHtml.set(action, await resolveMcpAppHtml(ui));
    count++;
  }
  if (count > 0) logger.debug(`Bundled ${count} MCP App UI resource(s)`);
}

/**
 * The pre-resolved HTML for an action's MCP App, or `undefined` if it was not resolved
 * at boot (callers fall back to `action.mcp.ui.html`).
 */
export function getResolvedMcpAppHtml(action: Action): string | undefined {
  return resolvedUiHtml.get(action);
}
