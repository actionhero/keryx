import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { api } from "../api";
import { ErrorType, TypedError } from "../classes/TypedError";

// Zod v4: Extend GlobalMeta to support custom 'isSecret' metadata
// This allows using .meta({ isSecret: true }) on any zod schema
declare module "zod/v4" {
  interface GlobalMeta {
    isSecret?: boolean;
  }
}

/**
 * Helper function to mark a zod schema as secret.
 * Uses Zod v4's native .meta() API.
 * @example
 * const passwordSchema = secret(z.string());
 */
export function secret<T extends z.ZodType>(schema: T): T {
  return schema.meta({ isSecret: true }) as T;
}

/**
 * Check if a zod schema is marked as secret.
 * @example
 * if (isSecret(schema)) { ... }
 */
export function isSecret(schema: z.ZodType): boolean {
  return schema.meta()?.isSecret === true;
}

/**
 * Creates a Zod schema that accepts both boolean and string values,
 * transforming string representations of booleans to actual booleans.
 * Useful for handling form data where booleans come as strings.
 */
export function zBooleanFromString() {
  return z.union([z.boolean(), z.string()]).transform((val) => {
    if (typeof val === "boolean") return val;
    if (typeof val === "string") {
      if (val.toLowerCase() === "true") return true;
      if (val.toLowerCase() === "false") return false;
    }
    return false;
  });
}

/**
 * Creates a Zod schema for pagination inputs with sensible defaults.
 * Returns `{ page, limit }` where `page` is 1-indexed.
 *
 * @param options - Optional overrides for default values and bounds.
 * @param options.defaultLimit - Default number of items per page (default: 25).
 * @param options.maxLimit - Maximum allowed items per page (default: 100).
 * @returns A Zod object schema with `page` and `limit` fields.
 */
export function paginationInputs(options?: {
  defaultLimit?: number;
  maxLimit?: number;
}) {
  const defaultLimit = options?.defaultLimit ?? 25;
  const maxLimit = options?.maxLimit ?? 100;

  return z.object({
    page: z.coerce
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Page number (1-indexed)"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(maxLimit)
      .default(defaultLimit)
      .describe("Number of items per page"),
  });
}

// Type for Drizzle tables with an id column
type TableWithId = { id: any; $inferSelect: any };

/**
 * Generic factory to create a Zod schema that accepts either an ID or a model object.
 * If an ID is provided, it resolves to the full model via database lookup.
 *
 * @param table - Drizzle table definition (must have an `id` column)
 * @param modelSchema - Zod schema for the model (from createSelectSchema)
 * @param isModel - Type guard function to check if value is already a model
 * @param entityName - Human-readable name for error messages
 */
export function zIdOrModel<TTable extends TableWithId, TModel>(
  table: TTable,
  modelSchema: z.ZodType<TModel>,
  isModel: (val: unknown) => val is TModel,
  entityName: string,
) {
  return z
    .union([z.coerce.number().int().positive(), modelSchema])
    .transform(async (val): Promise<TModel> => {
      if (isModel(val)) {
        return val;
      }
      const [record] = await api.db.db
        .select()
        .from(table as any)
        .where(eq((table as any).id, val))
        .limit(1);

      if (!record) {
        throw new TypedError({
          message: `${entityName} with id ${val} not found`,
          type: ErrorType.CONNECTION_ACTION_RUN,
        });
      }
      return record as TModel;
    })
    .describe(`A ${entityName} ID or ${entityName} object`);
}
