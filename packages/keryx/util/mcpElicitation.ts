import type {
  ClientCapabilities,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { ElicitRequestFormParamsSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { z } from "zod";
import { ErrorType, TypedError } from "../classes/TypedError";

/** Result action returned by an MCP client for an elicitation request. */
export type McpElicitationAction = ElicitResult["action"];

/** Result of an MCP form elicitation, with accepted content inferred from its Zod schema. */
export type McpFormElicitationResult<TSchema extends z.ZodType> =
  | { action: "accept"; content: z.infer<TSchema> }
  | { action: "decline" | "cancel"; content?: undefined };

/** Result of an MCP URL elicitation. Acceptance means consent, not completion. */
export type McpUrlElicitationResult = {
  action: McpElicitationAction;
  elicitationId: string;
};

/** @internal Request-scoped MCP functions attached by the MCP transport. */
export type McpElicitationContext = {
  clientCapabilities?: ClientCapabilities;
  requestSignal: AbortSignal;
  elicitInput: (
    params: ElicitRequestFormParams | ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>;
  completeElicitation: (elicitationId: string) => Promise<void>;
};

type McpElicitationState = {
  connectionType: string;
  context?: McpElicitationContext;
  actionAbortSignal?: AbortSignal;
};

/**
 * Ask an MCP client to collect and validate structured input.
 *
 * @param state - Current connection type, request context, and action abort signal.
 * @param options - Human-readable prompt and flat Zod schema supported by MCP.
 * @returns The client's decision and validated content when accepted.
 * @throws {TypedError} When MCP is unavailable, the schema is incompatible, or
 * accepted content fails validation.
 * @internal
 */
export async function elicitMcpForm<TSchema extends z.ZodType>(
  state: McpElicitationState,
  options: {
    message: string;
    schema: TSchema;
  },
): Promise<McpFormElicitationResult<TSchema>> {
  const context = requireMcpElicitation(state, "form");
  let requestedSchema: ElicitRequestFormParams["requestedSchema"];
  try {
    requestedSchema = ElicitRequestFormParamsSchema.shape.requestedSchema.parse(
      z.toJSONSchema(options.schema, { target: "draft-7", io: "input" }),
    );
  } catch (cause) {
    throw new TypedError({
      message: `Invalid MCP form elicitation schema: ${cause}`,
      type: ErrorType.CONNECTION_MCP_ELICITATION,
      cause,
    });
  }

  const result = await context.elicitInput(
    { mode: "form", message: options.message, requestedSchema },
    mcpElicitationSignal(context, state.actionAbortSignal),
  );
  if (result.action !== "accept") return { action: result.action };

  const parsed = await options.schema.safeParseAsync(result.content);
  if (!parsed.success) {
    throw new TypedError({
      message: `MCP client returned invalid elicitation content: ${parsed.error.message}`,
      type: ErrorType.CONNECTION_MCP_ELICITATION,
      cause: parsed.error,
    });
  }
  return { action: "accept", content: parsed.data };
}

/**
 * Ask an MCP client for consent to open an out-of-band URL.
 *
 * @param state - Current connection type, request context, and action abort signal.
 * @param options - Message, absolute URL, and optional stable elicitation id.
 * @returns The client's decision and the elicitation id used for completion.
 * @throws {TypedError} When MCP or URL elicitation is unavailable, or `url` is invalid.
 * @internal
 */
export async function elicitMcpUrl(
  state: McpElicitationState,
  options: {
    message: string;
    url: string | URL;
    elicitationId?: string;
  },
): Promise<McpUrlElicitationResult> {
  const context = requireMcpElicitation(state, "url");
  let url: string;
  try {
    url = new URL(options.url).toString();
  } catch (cause) {
    throw new TypedError({
      message: `Invalid MCP elicitation URL: ${options.url}`,
      type: ErrorType.CONNECTION_MCP_ELICITATION,
      cause,
    });
  }

  const elicitationId = options.elicitationId ?? randomUUID();
  const result = await context.elicitInput(
    {
      mode: "url",
      message: options.message,
      url,
      elicitationId,
    },
    mcpElicitationSignal(context, state.actionAbortSignal),
  );
  return { action: result.action, elicitationId };
}

/**
 * Notify the initiating MCP client that URL elicitation completed.
 *
 * @param state - Current connection type and request context.
 * @param elicitationId - Stable id supplied to URL elicitation.
 * @returns A promise that resolves after the notification is sent.
 * @throws {TypedError} When called outside an active URL-capable MCP request.
 * @internal
 */
export async function completeMcpElicitation(
  state: McpElicitationState,
  elicitationId: string,
): Promise<void> {
  const context = requireMcpElicitation(state, "url");
  await context.completeElicitation(elicitationId);
}

function requireMcpElicitation(
  state: McpElicitationState,
  mode: "form" | "url",
): McpElicitationContext {
  if (state.connectionType !== "mcp") {
    throw new TypedError({
      message: `MCP elicitation is only available on MCP connections (got ${state.connectionType})`,
      type: ErrorType.CONNECTION_MCP_ELICITATION,
    });
  }

  const context = state.context;
  if (!context) {
    throw new TypedError({
      message: "MCP elicitation is only available during an MCP request",
      type: ErrorType.CONNECTION_MCP_ELICITATION,
    });
  }

  const elicitation = context.clientCapabilities?.elicitation;
  const supportsForm =
    elicitation !== undefined &&
    (elicitation.form !== undefined || Object.keys(elicitation).length === 0);
  const supported =
    mode === "form" ? supportsForm : elicitation?.url !== undefined;
  if (!supported) {
    throw new TypedError({
      message: `MCP client does not support ${mode} elicitation`,
      type: ErrorType.CONNECTION_MCP_ELICITATION,
    });
  }
  return context;
}

function mcpElicitationSignal(
  context: McpElicitationContext,
  actionAbortSignal?: AbortSignal,
): AbortSignal {
  return actionAbortSignal
    ? AbortSignal.any([context.requestSignal, actionAbortSignal])
    : context.requestSignal;
}
