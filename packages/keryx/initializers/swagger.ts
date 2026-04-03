import { api, logger } from "../api";
import { Initializer } from "../classes/Initializer";
import type { JSONSchema } from "../util/swaggerSchemaGenerator";
import {
  computeActionsHash,
  generateSwaggerSchemas,
  loadCachedSchemas,
  writeSchemasCache,
} from "../util/swaggerSchemaGenerator";

const namespace = "swagger";

declare module "../classes/API" {
  export interface API {
    [namespace]: Awaited<ReturnType<SwaggerInitializer["initialize"]>>;
  }
}

export class SwaggerInitializer extends Initializer {
  constructor() {
    super(namespace);
    this.loadPriority = 150; // After actions (100)
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
