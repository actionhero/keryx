import type { ElicitRequestURLParams } from "@modelcontextprotocol/sdk/types.js";
import { ErrorType, TypedError } from "./TypedError";

/**
 * Signals that an MCP request cannot continue until the client completes one or
 * more URL elicitations and retries the original request.
 *
 * Throw this from an MCP action when work cannot remain pending inside the current
 * tool call. Keryx maps it to the MCP `-32042` URL elicitation required error.
 */
export class McpUrlElicitationRequiredError extends TypedError {
  /** URL elicitations the client must complete before retrying. */
  readonly elicitations: ElicitRequestURLParams[];

  /**
   * Create a URL elicitation required error.
   *
   * @param elicitations - One or more URL-mode elicitation descriptions. Each must
   * include a stable `elicitationId`, absolute `url`, and user-facing `message`.
   * @param message - Error message shown to the MCP client.
   */
  constructor(
    elicitations: ElicitRequestURLParams[],
    message = "This request requires additional information.",
  ) {
    super({
      message,
      type: ErrorType.CONNECTION_MCP_ELICITATION,
    });
    this.elicitations = elicitations;
  }
}
