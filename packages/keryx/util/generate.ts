import fs from "fs";
import Mustache from "mustache";
import path from "path";
import type { PluginGenerator } from "../classes/Plugin";
import { config } from "../config";

const VALID_TYPES = [
  "action",
  "initializer",
  "middleware",
  "channel",
  "ops",
  "plugin",
] as const;
type GeneratorType = (typeof VALID_TYPES)[number];

/**
 * Returns all valid generator types, including built-in types and
 * any custom types registered by plugins.
 */
export function getValidTypes(): string[] {
  const types = [...VALID_TYPES] as string[];
  for (const plugin of config.plugins) {
    if (plugin.generators) {
      for (const gen of plugin.generators) {
        if (!types.includes(gen.type)) types.push(gen.type);
      }
    }
  }
  return types;
}

/**
 * Find a plugin generator definition for a given type.
 */
function findPluginGenerator(type: string): PluginGenerator | undefined {
  for (const plugin of config.plugins) {
    if (plugin.generators) {
      const gen = plugin.generators.find((g) => g.type === type);
      if (gen) return gen;
    }
  }
  return undefined;
}

export interface GenerateOptions {
  dryRun?: boolean;
  force?: boolean;
  noTest?: boolean;
}

const templatesDir = path.join(import.meta.dir, "..", "templates", "generate");

async function loadTemplate(name: string): Promise<string> {
  return Bun.file(path.join(templatesDir, name)).text();
}

/**
 * Convert a colon-separated name to PascalCase class name.
 * e.g. "user:delete" → "UserDelete", "hello" → "Hello"
 */
function toClassName(name: string): string {
  return name
    .split(":")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

/**
 * Determine the directory and filename for a component type + name.
 * Actions with colons get nested: "user:delete" → "actions/user/delete.ts"
 * Others are flat: "cache" → "initializers/cache.ts"
 */
function resolveFilePath(type: GeneratorType, name: string): string {
  const dirMap: Record<GeneratorType, string> = {
    action: "actions",
    initializer: "initializers",
    middleware: "middleware",
    channel: "channels",
    ops: "ops",
    plugin: "plugins",
  };

  const baseDir = dirMap[type];
  const segments = name.split(":");

  if (segments.length > 1) {
    // "user:delete" → "actions/user/delete.ts"
    const fileName = segments.pop()!;
    return path.join(baseDir, ...segments, `${fileName}.ts`);
  }

  return path.join(baseDir, `${name}.ts`);
}

/**
 * Determine the directory and filename for a plugin generator type + name.
 */
function resolvePluginFilePath(gen: PluginGenerator, name: string): string {
  const segments = name.split(":");
  if (segments.length > 1) {
    const fileName = segments.pop()!;
    return path.join(gen.directory, ...segments, `${fileName}.ts`);
  }
  return path.join(gen.directory, `${name}.ts`);
}

/**
 * Determine the test file path for a plugin generator component.
 */
function resolvePluginTestPath(gen: PluginGenerator, name: string): string {
  const componentPath = resolvePluginFilePath(gen, name);
  const parsed = path.parse(componentPath);
  return path.join("__tests__", parsed.dir, `${parsed.name}.test.ts`);
}

/**
 * Determine the test file path for a component.
 * "user:delete" action → "__tests__/actions/user/delete.test.ts"
 */
function resolveTestPath(type: GeneratorType, name: string): string {
  const componentPath = resolveFilePath(type, name);
  const parsed = path.parse(componentPath);
  return path.join("__tests__", parsed.dir, `${parsed.name}.test.ts`);
}

/**
 * Derive the web route from an action name.
 * "hello" → "/api/hello", "user:delete" → "/api/user/delete"
 */
function toRoute(name: string): string {
  return "/" + name.replace(/:/g, "/");
}

/**
 * Generate a component file (and optionally a test file).
 * @param type The component type to generate
 * @param name The component name (e.g., "user:delete", "cache")
 * @param rootDir The project root directory
 * @param options Generation options (dry-run, force, no-test)
 * @returns List of created (or would-be-created) file paths
 */
export async function generateComponent(
  type: string,
  name: string,
  rootDir: string,
  options: GenerateOptions = {},
): Promise<string[]> {
  const allValidTypes = getValidTypes();
  if (!allValidTypes.includes(type)) {
    throw new Error(
      `Unknown generator type "${type}". Valid types: ${allValidTypes.join(", ")}`,
    );
  }

  // Check if this is a plugin-provided generator type
  const pluginGen = VALID_TYPES.includes(type as GeneratorType)
    ? undefined
    : findPluginGenerator(type);

  const filePath = pluginGen
    ? resolvePluginFilePath(pluginGen, name)
    : resolveFilePath(type as GeneratorType, name);
  const fullPath = path.join(rootDir, filePath);
  const createdFiles: string[] = [];

  // Check for conflicts
  if (!options.force && fs.existsSync(fullPath)) {
    throw new Error(
      `File already exists: ${filePath}. Use --force to overwrite.`,
    );
  }

  // Build template view
  let className = toClassName(name);
  if (type === "middleware") className += "Middleware";
  if (type === "channel") className += "Channel";
  if (type === "plugin") className += "Plugin";

  const view: Record<string, string> = { name, className };
  if (type === "action") {
    view.route = toRoute(name);
  }

  // Load and render template
  let content: string;
  if (pluginGen) {
    const templateStr = await Bun.file(pluginGen.templatePath).text();
    content = Mustache.render(templateStr, view);
  } else {
    const templateMap: Record<GeneratorType, string> = {
      action: "action.ts.mustache",
      initializer: "initializer.ts.mustache",
      middleware: "action-middleware.ts.mustache",
      channel: "channel.ts.mustache",
      ops: "ops.ts.mustache",
      plugin: "plugin.ts.mustache",
    };
    const template = await loadTemplate(templateMap[type as GeneratorType]);
    content = Mustache.render(template, view);
  }

  if (options.dryRun) {
    console.log(`Would create: ${filePath}`);
    console.log("---");
    console.log(content);
    createdFiles.push(filePath);
  } else {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    await Bun.write(fullPath, content);
    createdFiles.push(filePath);
  }

  // Generate test file
  if (!options.noTest) {
    const testPath = pluginGen
      ? resolvePluginTestPath(pluginGen, name)
      : resolveTestPath(type as GeneratorType, name);
    const testFullPath = path.join(rootDir, testPath);

    if (!options.force && fs.existsSync(testFullPath)) {
      // Silently skip test file if it already exists
    } else {
      let testContent: string;
      if (pluginGen?.testTemplatePath) {
        const testTemplateStr = await Bun.file(
          pluginGen.testTemplatePath,
        ).text();
        testContent = Mustache.render(testTemplateStr, view);
      } else {
        const testTemplate = await loadTemplate("test.ts.mustache");
        testContent = Mustache.render(testTemplate, view);
      }

      if (options.dryRun) {
        console.log(`Would create: ${testPath}`);
        createdFiles.push(testPath);
      } else {
        fs.mkdirSync(path.dirname(testFullPath), { recursive: true });
        await Bun.write(testFullPath, testContent);
        createdFiles.push(testPath);
      }
    }
  }

  return createdFiles;
}
