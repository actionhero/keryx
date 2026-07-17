import { fileURLToPath } from "node:url";
import { api, logger } from "../api";
import type { Action, McpUiConfig } from "../classes/Action";
import { ErrorType, TypedError } from "../classes/TypedError";

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
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; padding: 16px; }
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
/** Matches an empty `<script type="module">` tag (the preferred, declarative injection point). */
const EMPTY_MODULE_SCRIPT = /<script\s+type=["']module["']>\s*<\/script>/;

/** Resolved HTML per UI action, computed once at boot by {@link resolveMcpAppUiResources}. */
const resolvedUiHtml = new Map<Action, string>();

/**
 * Bundle a browser entrypoint into a single minified ESM string.
 *
 * Runs `bun build` in a **child process** rather than the in-process `Bun.build` API:
 * once the server has started, Bun has memory-mapped its loaded modules (e.g. zod), and
 * the in-process bundler fails to re-read them ("Unseekable reading file"). A fresh
 * process sidesteps that and is only paid once, at boot.
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

  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      entrypoint,
      "--target=browser",
      "--format=esm",
      "--minify",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [script, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0 || script.trim().length === 0) {
    throw new TypedError({
      message: `Failed to bundle MCP App client "${entrypoint}":\n${stderr || "no output"}`,
      type: ErrorType.SERVER_INITIALIZATION,
    });
  }

  return script;
}

/**
 * Inline a bundled client script into an HTML shell. Prefers an empty
 * `<script type="module"></script>`, then a `MCP_APP_CLIENT` placeholder comment,
 * then just before `</body>`, and finally appends as a last resort.
 *
 * Uses replacer functions so `$`-sequences in the bundled JS are inserted literally.
 */
function injectClientScript(shell: string, script: string): string {
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
 * Compute the served HTML for an MCP App's `mcp.ui` config.
 *
 * - With `client`: bundles it and inlines the result into `html` (or {@link DEFAULT_MCP_APP_SHELL}).
 * - With only `html`: returns it verbatim.
 *
 * @param ui - The action's `mcp.ui` config.
 * @returns The self-contained HTML to serve as the `ui://` resource.
 * @throws {TypedError} When neither `client` nor `html` is set, or bundling fails.
 */
export async function resolveMcpAppHtml(ui: McpUiConfig): Promise<string> {
  if (ui.client) {
    const script = await bundleMcpAppClient(ui.client);
    return injectClientScript(ui.html ?? DEFAULT_MCP_APP_SHELL, script);
  }
  if (ui.html !== undefined) return ui.html;
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
