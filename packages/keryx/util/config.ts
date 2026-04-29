/**
Deep-merges source into target, mutating target in place.
Only plain objects are recursively merged; arrays and primitives are overwritten.
*/
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const writable = target as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const targetVal = target[key];
    const sourceVal = source[key];

    if (
      targetVal &&
      sourceVal &&
      typeof targetVal === "object" &&
      typeof sourceVal === "object" &&
      !Array.isArray(targetVal) &&
      !Array.isArray(sourceVal)
    ) {
      deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      writable[key] = sourceVal;
    }
  }

  return target;
}

/**
 * Like `deepMerge`, but only sets values that don't already exist in target.
 * Useful for applying plugin config defaults without overwriting user-set values.
 */
export function deepMergeDefaults<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const writable = target as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(key in target)) {
      writable[key] = source[key];
    } else {
      const targetVal = target[key];
      const sourceVal = source[key];

      if (
        targetVal &&
        sourceVal &&
        typeof targetVal === "object" &&
        typeof sourceVal === "object" &&
        !Array.isArray(targetVal) &&
        !Array.isArray(sourceVal)
      ) {
        deepMergeDefaults(
          targetVal as Record<string, unknown>,
          sourceVal as Record<string, unknown>,
        );
      }
      // If key exists in target and isn't a nested object, keep the target value
    }
  }

  return target;
}

/**
 * Build a human-readable summary of how many components were loaded and where
 * they came from. Example: `"loaded 12 initializers (10 core, 1 from plugins, 1 user-defined)"`
 *
 * @param label - Plural noun for the component type (e.g. "actions", "servers").
 * @param counts - Breakdown by source. All fields are optional; zero-value
 *   categories are omitted from the output.
 */
export function formatLoadedMessage(
  label: string,
  counts: { core?: number; plugin?: number; user?: number },
): string {
  const total = (counts.core ?? 0) + (counts.plugin ?? 0) + (counts.user ?? 0);
  const parts: string[] = [];
  if (counts.core) parts.push(`${counts.core} core`);
  if (counts.plugin) parts.push(`${counts.plugin} from plugins`);
  if (counts.user) parts.push(`${counts.user} user-defined`);
  if (parts.length > 0) {
    return `loaded ${total} ${label} (${parts.join(", ")})`;
  }
  return `loaded ${total} ${label}`;
}

/**
Loads a value from the environment, if it's set, otherwise returns the default value.
*/
export async function loadFromEnvIfSet<T>(envString: string, defaultValue: T) {
  let val = defaultValue;
  const valFromEnv = Bun.env[envString];
  const env = (Bun.env.NODE_ENV || "development").toUpperCase();
  const valFromEnvNodeEnv = Bun.env[`${envString}_${env}`];
  const testVal = valFromEnvNodeEnv || valFromEnv;

  if (testVal !== undefined) {
    val = (
      typeof defaultValue === "boolean"
        ? testVal.trim().toUpperCase() === "TRUE"
        : typeof defaultValue === "number"
          ? testVal.includes(".")
            ? parseFloat(testVal)
            : parseInt(testVal)
          : testVal
    ) as T;
  }

  return val;
}
