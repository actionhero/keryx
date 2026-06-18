import path from "path";
import { config } from "../config";

/**
 * A component that can be produced by `keryx generate`.
 *
 * Built-in components (action, initializer, middleware, channel, ops, plugin)
 * and plugin-contributed generators are both represented as `ComponentDef`s,
 * so `generateComponent()` can handle them through a single code path.
 */
export interface ComponentDef {
  /** Generator type name — what the user passes as `keryx generate <type> <name>`. */
  type: string;
  /** Output subdirectory relative to the project root (e.g. `"actions"`). */
  directory: string;
  /** Absolute path to the Mustache template for the component file. */
  templatePath: string;
  /** Absolute path to the Mustache template for the test file. Falls back to the default generate/test.ts.mustache. */
  testTemplatePath?: string;
  /** Suffix appended to the PascalCase class name (e.g. `"Middleware"` → `FooMiddleware`). */
  classSuffix?: string;
  /** When true, a `route` field is added to the Mustache view (used by actions). */
  includeRoute?: boolean;
}

const generateTemplatesDir = path.join(
  import.meta.dir,
  "..",
  "templates",
  "generate",
);
const scaffoldTemplatesDir = path.join(
  import.meta.dir,
  "..",
  "templates",
  "scaffold",
);

const BUILT_IN_DEFS: ComponentDef[] = [
  {
    type: "action",
    directory: "actions",
    templatePath: path.join(generateTemplatesDir, "action.ts.mustache"),
    includeRoute: true,
  },
  {
    type: "initializer",
    directory: "initializers",
    templatePath: path.join(generateTemplatesDir, "initializer.ts.mustache"),
  },
  {
    type: "middleware",
    directory: "middleware",
    templatePath: path.join(
      generateTemplatesDir,
      "action-middleware.ts.mustache",
    ),
    classSuffix: "Middleware",
  },
  {
    type: "channel",
    directory: "channels",
    templatePath: path.join(generateTemplatesDir, "channel.ts.mustache"),
    classSuffix: "Channel",
  },
  {
    type: "ops",
    directory: "ops",
    templatePath: path.join(generateTemplatesDir, "ops.ts.mustache"),
  },
  {
    type: "plugin",
    directory: "plugins",
    templatePath: path.join(generateTemplatesDir, "plugin.ts.mustache"),
    classSuffix: "Plugin",
  },
];

/**
 * Returns all component definitions, merging built-ins with plugin-contributed generators.
 * Plugin generators with a type matching a built-in are ignored (built-ins win).
 */
export function getComponentDefs(): ComponentDef[] {
  const defs: ComponentDef[] = [...BUILT_IN_DEFS];
  const seen = new Set(defs.map((d) => d.type));
  for (const plugin of config.plugins) {
    if (!plugin.generators) continue;
    for (const gen of plugin.generators) {
      if (seen.has(gen.type)) continue;
      defs.push({
        type: gen.type,
        directory: gen.directory,
        templatePath: gen.templatePath,
        testTemplatePath: gen.testTemplatePath,
      });
      seen.add(gen.type);
    }
  }
  return defs;
}

/**
 * Look up a component definition by type. Returns undefined when unknown.
 */
export function getComponentDef(type: string): ComponentDef | undefined {
  return getComponentDefs().find((d) => d.type === type);
}

/**
 * Returns all valid generator type names (built-ins + plugin generators).
 */
export function getValidTypes(): string[] {
  return getComponentDefs().map((d) => d.type);
}

/**
 * Convert a colon-separated name to PascalCase.
 * e.g. "user:delete" → "UserDelete", "hello" → "Hello".
 */
export function toClassName(name: string): string {
  return name
    .split(":")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

/**
 * Derive a web route from a colon-separated action name.
 * "hello" → "/hello", "user:delete" → "/user/delete".
 */
export function toRoute(name: string): string {
  return "/" + name.replace(/:/g, "/");
}

/**
 * Resolve the component output path relative to the project root.
 * Colon-separated names nest under subdirectories:
 * "user:delete" with directory "actions" → "actions/user/delete.ts".
 */
export function resolveComponentPath(def: ComponentDef, name: string): string {
  const segments = name.split(":");
  if (segments.length > 1) {
    const fileName = segments.pop()!;
    return path.join(def.directory, ...segments, `${fileName}.ts`);
  }
  return path.join(def.directory, `${name}.ts`);
}

/**
 * Derive the test file path for a component path.
 * "actions/user/delete.ts" → "__tests__/actions/user/delete.test.ts".
 */
export function resolveTestPath(componentPath: string): string {
  const parsed = path.parse(componentPath);
  return path.join("__tests__", parsed.dir, `${parsed.name}.test.ts`);
}

/**
 * Build the Mustache view for a component, applying the definition's
 * class-suffix and route conventions.
 */
export function buildComponentView(
  def: ComponentDef,
  name: string,
): Record<string, string> {
  const className = toClassName(name) + (def.classSuffix ?? "");
  const view: Record<string, string> = { name, className };
  if (def.includeRoute) view.route = toRoute(name);
  return view;
}

/**
 * Load a template from `packages/keryx/templates/generate/`.
 */
export async function loadGenerateTemplate(name: string): Promise<string> {
  return Bun.file(path.join(generateTemplatesDir, name)).text();
}

/**
 * Load a template from `packages/keryx/templates/scaffold/`.
 */
export async function loadScaffoldTemplate(name: string): Promise<string> {
  return Bun.file(path.join(scaffoldTemplatesDir, name)).text();
}
