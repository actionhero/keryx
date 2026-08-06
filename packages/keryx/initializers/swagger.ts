import { api, logger } from "../api";
import { Initializer } from "../classes/Initializer";
import type { JSONSchema } from "../util/swaggerSchemaGenerator";
import {
  computeActionsHash,
  generateSwaggerSchemas,
  loadCachedSchemas,
  SCHEMA_CACHE_RELATIVE_PATH,
  writeSchemasCache,
} from "../util/swaggerSchemaGenerator";

const namespace = "swagger";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<SwaggerInitializer["initialize"]>>;
  }
}

export class SwaggerInitializer extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["actions"];
  }

  async initialize() {
    const hash = await computeActionsHash(api.rootDir);

    // Check cache
    const cached = await loadCachedSchemas(api.rootDir);
    if (cached && cached.hash === hash) {
      logger.debug(
        `Loaded ${Object.keys(cached.responseSchemas).length} OpenAPI response schemas from cache`,
      );
      return { responseSchemas: cached.responseSchemas };
    }

    // No usable cache, so we fall through to ts-morph. This is by far the most
    // expensive thing that happens at boot (it can peak over 1 GB of RSS on a
    // large app) and it is the usual cause of an unexplained OOM kill during
    // startup on a memory-capped host. Warn *before* doing the work — a process
    // that cannot afford the allocation never reaches a message logged after it.
    const cacheState = cached
      ? `swagger schema cache at ${SCHEMA_CACHE_RELATIVE_PATH} is stale`
      : `no swagger schema cache found at ${SCHEMA_CACHE_RELATIVE_PATH}`;
    logger.warn(
      `${cacheState}; generating response schemas via ts-morph. This takes seconds and can peak over 1 GB of RSS, which will OOM a memory-capped host. Run \`keryx build\` at build time to pre-generate them and skip this step — see \`keryx build --help\`.`,
    );

    // Generate schemas via ts-morph
    let responseSchemas: Record<string, JSONSchema> = {};
    try {
      const result = await generateSwaggerSchemas({
        rootDir: api.rootDir,
        packageDir: api.packageDir,
      });
      responseSchemas = result.responseSchemas;

      logger.info(
        `Generated ${Object.keys(responseSchemas).length} response schemas for swagger`,
      );

      // Write cache
      try {
        await writeSchemasCache(api.rootDir, {
          hash,
          responseSchemas,
        });
      } catch (error) {
        logger.warn(`Failed to write swagger schema cache: ${error}`);
      }
    } catch (error) {
      logger.error(`Failed to generate swagger response schemas: ${error}`);
      logger.warn(
        "Swagger response schemas are unavailable. Run `keryx build` at build time to pre-generate them.",
      );
    }

    return { responseSchemas };
  }
}
