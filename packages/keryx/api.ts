import { API } from "./classes/API";
import type { Logger } from "./classes/Logger";
import type { KeryxConfig } from "./config";
import { config as Config } from "./config";

export {
  Action,
  type ActionConstructorInputs,
  type ActionParams,
  type ActionResponse,
  type McpActionConfig,
  type OAuthActionResponse,
} from "./classes/Action";
export { API, RUN_MODE } from "./classes/API";
export {
  Channel,
  type ChannelConstructorInputs,
  type ChannelMiddleware,
} from "./classes/Channel";
export { CONNECTION_TYPE, Connection } from "./classes/Connection";
export { Initializer } from "./classes/Initializer";
export { LogFormat, Logger } from "./classes/Logger";
export { Server } from "./classes/Server";
export type {
  FanOutJob,
  FanOutOptions,
  FanOutResult,
  FanOutStatus,
} from "./initializers/actionts";

declare namespace globalThis {
  let api: API;
  let logger: Logger;
  let config: KeryxConfig;
}

if (!globalThis.api) {
  // @ts-ignore — augmented API properties (db, redis, etc.) are set later by initializers at runtime
  globalThis.api = new API();
  globalThis.logger = globalThis.api.logger;
  globalThis.config = Config as KeryxConfig;
}

/** The global API singleton. All framework state (actions, db, redis, etc.) is accessed through this object. */
export const api = globalThis.api;
/** Convenience re-export of `api.logger`. */
export const logger = globalThis.logger;
/** The merged configuration object (framework defaults + user overrides + env vars). */
export const config = globalThis.config;
