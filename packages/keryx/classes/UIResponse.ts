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
 * The class is generic over the shape of `structuredContent`. When you construct a
 * `UIResponse` from an object literal, `T` is inferred, so the field types flow through
 * to the action's `run()` return type — and from there into the generated OpenAPI/MCP
 * response schema, giving the app UI a fully-typed payload to bind against.
 *
 * Use the static factory {@link UIResponse.from} or the constructor directly.
 */
export class UIResponse<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Structured data delivered to the app UI for rendering (not added to model context). */
  readonly structuredContent: T;
  /**
   * Text representation added to the model's context. Defaults to
   * `JSON.stringify(structuredContent)` when not provided.
   */
  readonly text: string;

  /**
   * @param structuredContent - The structured data the app UI will render. Must be a
   *   JSON-serializable object; it is delivered to the app verbatim and is not added to
   *   the model's context. Its shape is captured as `T` so downstream schemas stay typed.
   * @param options - Optional model-facing text.
   * @param options.text - Text representation added to the model's context. When omitted,
   *   defaults to `JSON.stringify(structuredContent)`.
   */
  constructor(structuredContent: T, options?: { text?: string }) {
    this.structuredContent = structuredContent;
    this.text = options?.text ?? JSON.stringify(structuredContent);
  }

  /**
   * Convenience factory mirroring `StreamingResponse.sse()` / `.stream()`.
   *
   * @param structuredContent - The structured data the app UI will render.
   * @param options - Optional model-facing text (see the constructor).
   * @returns A new `UIResponse` whose `structuredContent` type is inferred from the argument.
   */
  static from<T extends Record<string, unknown>>(
    structuredContent: T,
    options?: { text?: string },
  ): UIResponse<T> {
    return new UIResponse(structuredContent, options);
  }

  /**
   * Serialize to the structured payload so non-MCP transports (HTTP, WebSocket, CLI)
   * return the data rather than the wrapper object.
   *
   * @returns The `structuredContent` object.
   */
  toJSON(): T {
    return this.structuredContent;
  }
}
