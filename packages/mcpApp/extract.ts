/**
 * The subset of an MCP tool result that carries app-renderable data. Both the
 * `ui/notifications/tool-result` params the host pushes and the `CallToolResult`
 * returned by `callServerTool` match this shape, so one extractor handles both.
 */
export interface ToolResultLike {
  /** Structured payload delivered verbatim to the app (Keryx's `UIResponse` or a promoted object result). */
  structuredContent?: unknown;
  /** Content blocks; the first text block is used as a JSON fallback when `structuredContent` is absent. */
  content?: Array<{ type?: string; text?: string } & Record<string, unknown>>;
}

/**
 * Pull an app's structured payload out of a tool result.
 *
 * Prefers `structuredContent` (delivered verbatim by Keryx's `UIResponse` and by
 * promoted plain-object tool results). Falls back to JSON-parsing the first text
 * content block — but only accepts a JSON **object**, since the model-facing text
 * summary is not necessarily JSON and arrays/scalars are not renderable payloads.
 *
 * @param result - A pushed tool-result notification or a `callServerTool` response.
 * @returns The structured object typed as `T`, or `null` when neither source yields an object.
 */
export function extractStructuredData<T extends Record<string, unknown>>(
  result: ToolResultLike,
): T | null {
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
  ) {
    return result.structuredContent as T;
  }

  const first = result.content?.[0];
  const text = first?.type === "text" ? first.text : undefined;
  if (typeof text === "string") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as T;
      }
    } catch {
      // The model-facing summary is not necessarily JSON.
    }
  }

  return null;
}
