import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Action } from "../classes/Action";
import { MCP_RESPONSE_FORMAT } from "../classes/Action";
import { StreamingResponse } from "../classes/StreamingResponse";
import { UIResponse } from "../classes/UIResponse";
import { config } from "../config";
import { toMarkdown } from "./toMarkdown";

/**
 * The `CallToolResult` for a failed action. Errors are always JSON, whatever the
 * action's `mcp.responseFormat`, so an agent can parse them reliably.
 *
 * @param error - The error's message and, when known, its `ErrorType`.
 */
export function toolErrorResult(error: {
  message: string;
  type?: string;
}): CallToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: error.message, type: error.type }),
      },
    ],
    isError: true,
  };
}

/**
 * Render an action's response as an MCP `CallToolResult`. This is the single
 * rendering used for a plain `tools/call` and for a task's `tasks/result`, so a
 * client sees the same shape either way.
 *
 * - A {@link StreamingResponse} is drained into one text block; each chunk is
 *   also handed to `onChunk` (a plain call forwards it as a logging message).
 * - A {@link UIResponse} carries its text and its `structuredContent`.
 * - Anything else is JSON (or markdown, per `mcp.responseFormat`), and a plain
 *   object is promoted to `structuredContent` so MCP Apps can bind to it.
 *
 * @param action - The action that produced the response; its `mcp.responseFormat` applies.
 * @param response - What the action returned.
 * @param onChunk - Optional observer for each chunk of a streaming response.
 */
export async function toCallToolResult(
  action: Action,
  response: unknown,
  onChunk?: (chunk: string) => void,
): Promise<CallToolResult> {
  if (response instanceof StreamingResponse) {
    const reader = response.stream.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        accumulated += chunk;
        onChunk?.(chunk);
      }
    } finally {
      response.onClose?.();
    }
    return { content: [{ type: "text" as const, text: accumulated }] };
  }

  // MCP App responses carry both a text block (added to model context)
  // and structuredContent (delivered to the app UI for rendering).
  // ext-apps hosts render the UI from the tool's `_meta.ui.resourceUri`
  // and the separate `ui://` resource — the content array stays text-only.
  if (response instanceof UIResponse) {
    return {
      content: [{ type: "text" as const, text: response.text }],
      structuredContent: response.structuredContent,
    };
  }

  const format = action.mcp?.responseFormat ?? MCP_RESPONSE_FORMAT.JSON;
  const text =
    format === MCP_RESPONSE_FORMAT.MARKDOWN
      ? toMarkdown(response, {
          maxDepth: config.server.mcp.markdownDepthLimit,
        })
      : JSON.stringify(response);

  // Promote plain object responses to structuredContent so MCP Apps can
  // bind without JSON.parse (same shape UIResponse already provides).
  const structuredContent =
    format === MCP_RESPONSE_FORMAT.JSON &&
    response !== null &&
    typeof response === "object" &&
    !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : undefined;

  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}
