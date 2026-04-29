// Side-effect imports: ensure module augmentation from all initializers is
// visible to tsc consumers. These only define classes and augment the API
// interface — no runtime side effects beyond module evaluation.
import "./initializers/actionts";
import "./initializers/channels";
import "./initializers/connections";
import "./initializers/db";
import "./initializers/hooks";
import "./initializers/mcp";
import "./initializers/oauth";
import "./initializers/observability";
import "./initializers/process";
import "./initializers/pubsub";
import "./initializers/redis";
import "./initializers/resque";
import "./initializers/servers";
import "./initializers/session";
import "./initializers/signals";
import "./initializers/swagger";

export * from "./api";
export type { ActionMiddleware } from "./classes/Action";
export { HTTP_METHOD, MCP_RESPONSE_FORMAT } from "./classes/Action";
export type { ChannelMiddleware } from "./classes/Channel";
export { CHANNEL_NAME_PATTERN } from "./classes/Channel";
export type {
  ActContext,
  ActOutcome,
  AfterActHook,
  BeforeActHook,
} from "./classes/Connection";
export { CONNECTION_TYPE, Connection } from "./classes/Connection";
export { LogLevel } from "./classes/Logger";
export type { KeryxPlugin, PluginGenerator } from "./classes/Plugin";
export { SSEResponse, StreamingResponse } from "./classes/StreamingResponse";
export { ErrorStatusCodes, ErrorType, TypedError } from "./classes/TypedError";
export type { KeryxConfig } from "./config";
export type { OnEnqueueHook } from "./initializers/actionts";
export type {
  OnMcpConnectHook,
  OnMcpDisconnectHook,
  OnMcpMessageHook,
} from "./initializers/mcp";
export type {
  AfterJobHook,
  BeforeJobHook,
  JobContext,
  JobOutcome,
} from "./initializers/resque";
export type { SessionData } from "./initializers/session";
export { checkRateLimit, RateLimitMiddleware } from "./middleware/rateLimit";
export { TransactionMiddleware } from "./middleware/transaction";
export type {
  AfterRequestHook,
  BeforeRequestHook,
  OnConnectHook,
  OnDisconnectHook,
  OnMessageHook,
  RequestContext,
  RequestOutcome,
  WebServer,
} from "./servers/web";
export { buildProgram } from "./util/cli";
export { deepMerge, deepMergeDefaults, loadFromEnvIfSet } from "./util/config";
export { getValidTypes } from "./util/generate";
export { globLoader } from "./util/glob";
export { type PaginatedResult, paginate } from "./util/pagination";
export { safeCompare } from "./util/safeCompare";
export type { JSONSchema } from "./util/swaggerSchemaGenerator";
export {
  computeActionsHash,
  generateSwaggerSchemas,
  loadCachedSchemas,
  writeSchemasCache,
} from "./util/swaggerSchemaGenerator";
export { toMarkdown } from "./util/toMarkdown";
export type { DbOrTransaction, Transaction } from "./util/transaction";
export { withTransaction } from "./util/transaction";
export {
  isSecret,
  paginationInputs,
  secret,
  zBooleanFromString,
  zIdOrModel,
} from "./util/zodMixins";
