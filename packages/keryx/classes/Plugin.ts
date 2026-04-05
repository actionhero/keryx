import type { Action } from "./Action";
import type { Channel } from "./Channel";
import type { Initializer } from "./Initializer";
import type { Server } from "./Server";

/**
 * A Keryx plugin manifest. Plugins provide class constructors that the framework
 * instantiates during discovery, alongside any config defaults and generator extensions.
 *
 * First-party plugins use the `@keryxjs/*` npm scope (e.g., `@keryxjs/resque-admin`).
 * Third-party plugins follow the `keryx-plugin-*` naming convention.
 *
 * Register plugins via config:
 * ```typescript
 * // config/plugins.ts
 * import { myPlugin } from "@keryxjs/my-plugin";
 * export default { plugins: [myPlugin] };
 * ```
 */
export interface KeryxPlugin {
  /** Unique plugin name (e.g., `"resque-admin"`). */
  name: string;
  /** SemVer version string for the plugin. */
  version: string;

  /** Initializer class constructors. Instantiated and merged into the lifecycle alongside framework and user initializers. */
  initializers?: Array<new () => Initializer>;
  /** Action class constructors. Instantiated and registered alongside user actions. */
  actions?: Array<new () => Action>;
  /** Channel class constructors. Instantiated and registered alongside user channels. */
  channels?: Array<new () => Channel>;
  /** Server class constructors. Instantiated and registered alongside framework and user servers. */
  servers?: Array<new () => Server<unknown>>;

  /** Config defaults merged before user config, so user overrides take precedence. */
  configDefaults?: Record<string, unknown>;

  /** Custom generator types for the `keryx generate` CLI command. */
  generators?: PluginGenerator[];
}

/**
 * A custom generator type that a plugin registers with the `keryx generate` CLI command.
 */
export interface PluginGenerator {
  /** The generator type name (e.g., `"graphql-resolver"`). Used as `keryx generate <type> <name>`. */
  type: string;
  /** The output subdirectory name relative to the project root (e.g., `"resolvers"`). */
  directory: string;
  /** Absolute path to the Mustache template file for the generated component. */
  templatePath: string;
  /** Absolute path to the Mustache template file for the generated test. If omitted, the default test template is used. */
  testTemplatePath?: string;
}
