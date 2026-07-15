/**
 * Response type for actions that back an **MCP App** (a dynamic UI).
 * Actions return a `UIResponse` from `run()` to hand the host two payloads at once:
 * a `structuredContent` object rendered by the app's HTML UI, and a `text`
 * representation added to the model's context.
 *
 * See {@link https://modelcontextprotocol.io/extensions/apps/overview | MCP Apps}.
 */

/**
 * A response that pairs app-facing structured data with model-facing text.
 *
 * Returned from an action whose `mcp.ui` config declares an HTML UI. The MCP
 * server delivers `structuredContent` to the app (via `ui/notifications/tool-result`,
 * where it is used for rendering and is *not* added to model context) and the
 * `text` as a normal text content block (which *is* added to model context).
 *
 * Over non-MCP transports (HTTP, WebSocket, CLI) a `UIResponse` serializes to
 * its `structuredContent` via {@link UIResponse.toJSON}, so the same action still
 * returns useful JSON everywhere.
 *
 * Use the static factory {@link UIResponse.from} or the constructor directly.
 */
export class UIResponse {
  /** Structured data delivered to the app UI for rendering (not added to model context). */
  readonly structuredContent: Record<string, unknown>;
  /**
   * Text representation added to the model's context. Defaults to
   * `JSON.stringify(structuredContent)` when not provided.
   */
  readonly text: string;

  /**
   * @param structuredContent - The structured data the app UI will render. Must be a
   *   JSON-serializable object; it is delivered to the app verbatim and is not added to
   *   the model's context.
   * @param options - Optional model-facing text.
   * @param options.text - Text representation added to the model's context. When omitted,
   *   defaults to `JSON.stringify(structuredContent)`.
   */
  constructor(
    structuredContent: Record<string, unknown>,
    options?: { text?: string },
  ) {
    this.structuredContent = structuredContent;
    this.text = options?.text ?? JSON.stringify(structuredContent);
  }

  /**
   * Convenience factory mirroring `StreamingResponse.sse()` / `.stream()`.
   *
   * @param structuredContent - The structured data the app UI will render.
   * @param options - Optional model-facing text (see the constructor).
   * @returns A new `UIResponse`.
   */
  static from(
    structuredContent: Record<string, unknown>,
    options?: { text?: string },
  ): UIResponse {
    return new UIResponse(structuredContent, options);
  }

  /**
   * Serialize to the structured payload so non-MCP transports (HTTP, WebSocket, CLI)
   * return the data rather than the wrapper object.
   *
   * @returns The `structuredContent` object.
   */
  toJSON(): Record<string, unknown> {
    return this.structuredContent;
  }
}
