import { Glob } from "bun";
import fs from "fs";
import path from "path";
import { config } from "../config";
import {
  deepMerge,
  deepMergeDefaults,
  formatLoadedMessage,
} from "../util/config";
import { globLoader } from "../util/glob";
import type { Initializer, InitializerSortKeys } from "./Initializer";
import { Logger } from "./Logger";
import { ErrorType, TypedError } from "./TypedError";

/** The mode the API process is running in, which determines which initializers start. */
export enum RUN_MODE {
  CLI = "cli",
  SERVER = "server",
}

let flapPreventer = false;

/**
 * The global singleton that manages the full framework lifecycle: initialize → start → stop.
 * All initializers attach their namespaces to this object (e.g., `api.db`, `api.actions`, `api.redis`).
 * Stored on `globalThis` so every module shares the same instance.
 */
export class API {
  /** The root directory of the user's application. Set this before calling `initialize()`. */
  rootDir: string;
  /** The root directory of the keryx package itself (auto-resolved from `import.meta.path`). */
  packageDir: string;
  /** Whether `initialize()` has completed successfully. */
  initialized: boolean;
  /** Whether `start()` has completed successfully. */
  started: boolean;
  /** Whether `stop()` has completed successfully. */
  stopped: boolean;
  /** Epoch timestamp (ms) when the API instance was created. */
  bootTime: number;
  /** The framework logger instance, configured from `config.logger`. */
  logger: Logger;
  /** The current run mode (SERVER or CLI), set during `start()`. */
  runMode!: RUN_MODE;
  /** All discovered initializer instances, sorted by the most-recently-used priority key. */
  initializers: Initializer[];

  // allow arbitrary properties to be set on the API, to be added and typed later
  [key: string]: any;

  constructor() {
    this.bootTime = new Date().getTime();
    this.packageDir = path.join(import.meta.path, "..", "..");
    this.rootDir = this.packageDir;
    this.logger = new Logger(config.logger);

    this.initialized = false;
    this.started = false;
    this.stopped = false;

    this.initializers = [];
  }

  /**
   * Load configuration overrides and discover + run all initializers.
   * Calls each initializer's `initialize()` method in `loadPriority` order.
   * The return value of each initializer is attached to `api[initializer.name]`.
   *
   * @throws {TypedError} With `ErrorType.SERVER_INITIALIZATION` if any initializer fails.
   */
  async initialize() {
    this.logger.warn("--- 🔄  Initializing process ---");
    this.initialized = false;

    await this.loadLocalConfig();
    this.loadPluginConfig();
    await this.findInitializers();
    this.sortInitializers("loadPriority");

    for (const initializer of this.initializers) {
      try {
        this.logger.debug(`Initializing initializer ${initializer.name}`);
        const response = await initializer.initialize?.();
        if (response) this[initializer.name] = response;
        this.logger.debug(`Initialized initializer ${initializer.name}`);
      } catch (e) {
        throw new TypedError({
          message: `${e}`,
          type: ErrorType.SERVER_INITIALIZATION,
          originalError: e,
        });
      }
    }

    this.initialized = true;
    this.logger.warn("--- 🔄  Initializing complete ---");
  }

  /**
   * Start the framework: connect to external services, bind server ports, start workers.
   * Calls `initialize()` first if it hasn't been run yet, then calls each initializer's
   * `start()` method in `startPriority` order. Initializers whose `runModes` do not include
   * the current `runMode` are skipped.
   *
   * @param runMode - Whether to start in SERVER mode (HTTP/WebSocket) or CLI mode.
   *   Defaults to `RUN_MODE.SERVER`. Initializers can opt out of specific modes via their
   *   `runModes` property.
   * @throws {TypedError} With `ErrorType.SERVER_START` if any initializer fails to start.
   */
  async start(runMode: RUN_MODE = RUN_MODE.SERVER) {
    this.stopped = false;
    this.started = false;
    this.runMode = runMode;
    if (!this.initialized) await this.initialize();

    this.logger.warn("--- 🔼  Starting process ---");

    this.sortInitializers("startPriority");

    for (const initializer of this.initializers) {
      if (!initializer.runModes.includes(runMode)) {
        this.logger.debug(
          `Not starting initializer ${initializer.name} in ${runMode} mode`,
        );
        continue;
      }

      try {
        this.logger.debug(`Starting initializer ${initializer.name}`);
        await initializer.start?.();
        this.logger.debug(`Started initializer ${initializer.name}`);
      } catch (e) {
        throw new TypedError({
          message: `${e}`,
          type: ErrorType.SERVER_START,
          originalError: e,
        });
      }
    }

    this.started = true;
    this.logger.warn("--- 🔼  Starting complete ---");
  }

  /**
   * Gracefully shut down the framework: disconnect from services, close server ports, stop workers.
   * Calls each initializer's `stop()` method in `stopPriority` order. No-ops if already stopped.
   *
   * @throws {TypedError} With `ErrorType.SERVER_STOP` if any initializer fails to stop.
   */
  async stop() {
    if (this.stopped) {
      this.logger.warn("API is already stopped");
      return;
    }

    this.logger.warn("--- 🔽  Stopping process ---");

    this.sortInitializers("stopPriority");

    for (const initializer of this.initializers) {
      try {
        this.logger.debug(`Stopping initializer ${initializer.name}`);
        await initializer.stop?.();
        this.logger.debug(`Stopped initializer ${initializer.name}`);
      } catch (e) {
        throw new TypedError({
          message: `${e}`,
          type: ErrorType.SERVER_STOP,
          originalError: e,
        });
      }
    }

    this.stopped = true;
    this.started = false;
    this.logger.warn("--- 🔽  Stopping complete ---");
  }

  /**
   * Stop and then re-start the framework. Includes a flap preventer that ignores
   * concurrent restart calls to avoid rapid stop/start cycles.
   */
  async restart() {
    if (flapPreventer) return;

    flapPreventer = true;
    await this.stop();
    await this.start();
    flapPreventer = false;
  }

  private async loadLocalConfig() {
    if (this.rootDir === this.packageDir) return;

    const configDir = path.join(this.rootDir, "config");
    if (!fs.existsSync(configDir)) return;

    const glob = new Glob("**/*.ts");
    for await (const file of glob.scan(configDir)) {
      if (file.startsWith(".")) continue;

      const fullPath = path.join(configDir, file);
      const mod = await import(fullPath);
      const overrides = mod.default ?? mod;
      if (overrides && typeof overrides === "object") {
        deepMerge(config, overrides);
        this.logger.debug(`Loaded user config from config/${file}`);
      }
    }
  }

  /**
   * Apply plugin config defaults using deepMergeDefaults so that
   * user-set config values are never overwritten by plugin defaults.
   */
  private loadPluginConfig() {
    for (const plugin of config.plugins) {
      if (plugin.configDefaults) {
        deepMergeDefaults(config, plugin.configDefaults);
        this.logger.debug(`Merged config defaults from plugin ${plugin.name}`);
      }
    }
  }

  private async findInitializers() {
    // Load framework initializers from the package directory
    const frameworkInitializers = await globLoader<Initializer>(
      path.join(this.packageDir, "initializers"),
    );
    for (const i of frameworkInitializers) {
      this.initializers.push(i);
    }

    // Load plugin initializers
    let pluginInitializerCount = 0;
    for (const plugin of config.plugins) {
      if (plugin.initializers) {
        for (const InitializerClass of plugin.initializers) {
          this.initializers.push(new InitializerClass());
          pluginInitializerCount++;
        }
      }
    }

    // Load user project initializers (if rootDir differs from packageDir)
    if (this.rootDir !== this.packageDir) {
      try {
        const userInitializers = await globLoader<Initializer>(
          path.join(this.rootDir, "initializers"),
        );
        for (const i of userInitializers) {
          this.initializers.push(i);
        }
      } catch {
        // user project may not have initializers, that's fine
      }
    }

    this.logger.info(
      formatLoadedMessage("initializers", {
        core: frameworkInitializers.length,
        plugin: pluginInitializerCount,
        user:
          this.initializers.length -
          frameworkInitializers.length -
          pluginInitializerCount,
      }),
    );
  }

  private sortInitializers(key: InitializerSortKeys) {
    this.initializers.sort((a, b) => a[key] - b[key]);
  }
}
