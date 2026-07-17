import { App } from "@modelcontextprotocol/ext-apps";
import { extractStructuredData } from "./extract";

export { App } from "@modelcontextprotocol/ext-apps";
export { extractStructuredData, type ToolResultLike } from "./extract";

/**
 * Options for {@link mountMcpApp}.
 *
 * @typeParam T - Shape of the structured data your action delivers (from a `UIResponse`
 *   or a plain object result). Match it to your action's `run()` return type.
 */
export interface MountMcpAppOptions<T extends Record<string, unknown>> {
  /** App name reported to the host during the handshake. Defaults to `"MCP App"`. */
  name?: string;
  /** App version reported to the host. Defaults to `"1.0.0"`. */
  version?: string;
  /**
   * Render fresh structured data into the DOM. Called for the initial tool result and
   * after every {@link McpAppHandle.refresh}. `root` is resolved from {@link MountMcpAppOptions.root}.
   *
   * @param data - The structured payload for this render.
   * @param root - The resolved root element (see {@link MountMcpAppOptions.root}).
   */
  render: (data: T, root: HTMLElement) => void;
  /**
   * Called when connecting, hydrating, or refreshing fails. When omitted, errors are
   * swallowed (the app simply shows its initial markup); provide this to surface failures.
   *
   * @param error - The thrown error or protocol failure.
   */
  onError?: (error: unknown) => void;
  /**
   * Element (or CSS selector) passed to {@link MountMcpAppOptions.render}. Defaults to
   * `"#root"` — the element the default MCP App shell provides. Ignored if your render
   * function targets its own elements directly.
   */
  root?: string | HTMLElement;
  /**
   * Tool used to (re)fetch data for {@link McpAppHandle.refresh} and to self-hydrate when
   * the host does not replay the initial tool result. Defaults to the app's own tool
   * (discovered from the host context) when the host provides it.
   */
  refreshTool?: { name: string; arguments?: Record<string, unknown> };
}

/** Handle returned by {@link mountMcpApp}. */
export interface McpAppHandle {
  /** The underlying `@modelcontextprotocol/ext-apps` {@link App} instance, for advanced use. */
  app: App;
  /**
   * Re-fetch data via the refresh tool and re-render.
   * @throws {Error} If no refresh tool can be resolved, or the tool returns no renderable data.
   */
  refresh: () => Promise<void>;
}

/**
 * Mount an MCP App: connect to the host, render its structured data, and keep it fresh —
 * capturing the whole `@modelcontextprotocol/ext-apps` lifecycle so you don't have to.
 *
 * It registers the tool-result handler **before** `connect()` (so the host's initial push
 * is never missed), then, once connected, **self-hydrates** by calling the refresh tool if
 * that push never arrived — the workaround some hosts (e.g. Cursor) require.
 *
 * @typeParam T - Shape of your action's structured data.
 * @param options - See {@link MountMcpAppOptions}.
 * @returns A {@link McpAppHandle} exposing `refresh()` and the underlying `App`.
 *
 * @example
 * ```ts
 * import { mountMcpApp } from "@keryxjs/mcp-app";
 *
 * type Status = { name: string; uptime: number };
 *
 * mountMcpApp<Status>({
 *   name: "Server Status",
 *   render: (data, root) => {
 *     root.textContent = `${data.name} — up ${Math.round(data.uptime / 1000)}s`;
 *   },
 *   refreshTool: { name: "status" },
 * });
 * ```
 */
export async function mountMcpApp<T extends Record<string, unknown>>(
  options: MountMcpAppOptions<T>,
): Promise<McpAppHandle> {
  const app = new App({
    name: options.name ?? "MCP App",
    version: options.version ?? "1.0.0",
  });

  const resolveRoot = (): HTMLElement => {
    const { root } = options;
    if (root instanceof HTMLElement) return root;
    const selector = typeof root === "string" ? root : "#root";
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) {
      throw new Error(`mountMcpApp: root element "${selector}" not found`);
    }
    return el;
  };

  let rendered = false;
  const renderData = (data: T | null): boolean => {
    if (!data) return false;
    options.render(data, resolveRoot());
    rendered = true;
    return true;
  };

  const resolveRefreshTool = () => {
    if (options.refreshTool) return options.refreshTool;
    const name = app.getHostContext()?.toolInfo?.tool.name;
    return name
      ? { name, arguments: {} as Record<string, unknown> }
      : undefined;
  };

  const refresh = async (): Promise<void> => {
    const tool = resolveRefreshTool();
    if (!tool) {
      throw new Error(
        "mountMcpApp: refresh() needs a refreshTool (none provided and the host did not supply the current tool)",
      );
    }
    const result = await app.callServerTool({
      name: tool.name,
      arguments: tool.arguments ?? {},
    });
    if (!renderData(extractStructuredData<T>(result))) {
      throw new Error("mountMcpApp: refresh tool returned no renderable data");
    }
  };

  // Register the result handler and error handler BEFORE connect() so the host
  // cannot race them with its initial tool-result push.
  app.addEventListener("toolresult", (params) => {
    renderData(extractStructuredData<T>(params));
  });
  app.onerror = (error) => options.onError?.(error);

  try {
    await app.connect();
    // Some hosts do not replay the tool result after the handshake; hydrate
    // ourselves if the "toolresult" push never fired.
    if (!rendered) await refresh();
  } catch (error) {
    options.onError?.(error);
  }

  return { app, refresh };
}
