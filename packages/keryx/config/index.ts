import type { KeryxPlugin } from "../classes/Plugin";
import { configActions } from "./actions";
import { configChannels } from "./channels";
import { configDatabase } from "./database";
import { configLogger } from "./logger";
import { configObservability } from "./observability";
import { configPlugins } from "./plugins";
import { configProcess } from "./process";
import { configRateLimit } from "./rateLimit";
import { configRedis } from "./redis";
import { configServerCli } from "./server/cli";
import { configServerMcp } from "./server/mcp";
import { configServerWeb } from "./server/web";
import { configSession } from "./session";
import { configTasks } from "./tasks";

export const config = {
  plugins: configPlugins,
  actions: configActions,
  channels: configChannels,
  process: configProcess,
  logger: configLogger,
  database: configDatabase,
  observability: configObservability,
  redis: configRedis,
  rateLimit: configRateLimit,
  session: configSession,
  server: { cli: configServerCli, web: configServerWeb, mcp: configServerMcp },
  tasks: configTasks,
};

/**
 * The type of the merged configuration object. Applications can extend this
 * via module augmentation to add custom config sections:
 *
 * ```typescript
 * declare module "keryx" {
 *   interface KeryxConfig {
 *     audit: { retentionDays: number };
 *   }
 * }
 * ```
 */
export interface KeryxConfig {
  plugins: KeryxPlugin[];
  actions: typeof configActions;
  channels: typeof configChannels;
  process: typeof configProcess;
  logger: typeof configLogger;
  database: typeof configDatabase;
  observability: typeof configObservability;
  redis: typeof configRedis;
  rateLimit: typeof configRateLimit;
  session: typeof configSession;
  server: {
    cli: typeof configServerCli;
    web: typeof configServerWeb;
    mcp: typeof configServerMcp;
  };
  tasks: typeof configTasks;
}
