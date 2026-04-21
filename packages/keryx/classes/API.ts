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
import type { Initializer } from "./Initializer";
import { Logger } from "./Logger";
import { ErrorType, TypedError } from "./TypedError";

/** The mode the API process is running in, which determines which initializers start. */
export enum RUN_MODE {
  CLI = "cli",
  SERVER = "server",
}

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
  /** All discovered initializer instances, topologically sorted by `dependsOn` after discovery. */
  initializers: Initializer[];
  /** Guards `restart()` against concurrent re-entry so rapid stop/start cycles get coalesced. */
  private flapPreventer = false;

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
   * Calls each initializer's `initialize()` method in dependency order (topological sort of `dependsOn`).
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
    this.topologicallySortInitializers();
    this.logInitializerDag();

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

    this.validateInitializerProperties("initialize");

    this.initialized = true;
    this.logger.warn("--- 🔄  Initializing complete ---");
  }

  /**
   * Start the framework: connect to external services, bind server ports, start workers.
   * Calls `initialize()` first if it hasn't been run yet, then calls each initializer's
   * `start()` method in dependency order. Initializers whose `runModes` do not include
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

    this.validateInitializerProperties("start");

    this.started = true;
    this.logger.warn("--- 🔼  Starting complete ---");
  }

  /**
   * Gracefully shut down the framework: disconnect from services, close server ports, stop workers.
   * Calls each initializer's `stop()` method in reverse dependency order (dependents stop before
   * their dependencies). No-ops if already stopped.
   *
   * @throws {TypedError} With `ErrorType.SERVER_STOP` if any initializer fails to stop.
   */
  async stop() {
    if (this.stopped) {
      this.logger.warn("API is already stopped");
      return;
    }

    this.logger.warn("--- 🔽  Stopping process ---");

    for (const initializer of [...this.initializers].reverse()) {
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
    if (this.flapPreventer) return;

    this.flapPreventer = true;
    await this.stop();
    await this.start();
    this.flapPreventer = false;
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
    // Reset so that re-running `initialize()` (e.g. between test files that share
    // the `globalThis.api` singleton) produces a deterministic graph rather than
    // accumulating duplicates from previous runs.
    this.initializers = [];

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

  /**
   * Reorder `this.initializers` into a topological execution order derived from each
   * initializer's `dependsOn` list. Uses Kahn's algorithm with insertion-order tie-breaking
   * so framework initializers keep their relative load order when they are mutually
   * independent. Throws on missing dependencies or cycles — both indicate misconfiguration
   * that would otherwise surface as confusing runtime errors.
   *
   * @throws {TypedError} With `ErrorType.INITIALIZER_VALIDATION` on unknown dependency
   *   names or circular dependency chains.
   */
  private topologicallySortInitializers() {
    const byName = new Map<string, Initializer>();
    for (const i of this.initializers) byName.set(i.name, i);

    // Validate dependency names exist before we try to sort.
    for (const i of this.initializers) {
      for (const dep of i.dependsOn) {
        if (!byName.has(dep)) {
          throw new TypedError({
            type: ErrorType.INITIALIZER_VALIDATION,
            message: `Initializer "${i.name}" depends on unknown initializer "${dep}". Available: ${[...byName.keys()].join(", ")}.`,
          });
        }
      }
    }

    // Kahn's algorithm. `indegree[name]` = number of unresolved deps.
    const indegree = new Map<string, number>();
    for (const i of this.initializers) indegree.set(i.name, i.dependsOn.length);

    // Reverse adjacency: for each dep, who depends on it?
    const dependents = new Map<string, string[]>();
    for (const i of this.initializers) {
      for (const dep of i.dependsOn) {
        const list = dependents.get(dep) ?? [];
        list.push(i.name);
        dependents.set(dep, list);
      }
    }

    const sorted: Initializer[] = [];
    // Seed the queue with zero-indegree initializers, preserving original insertion order.
    const queue: Initializer[] = this.initializers.filter(
      (i) => indegree.get(i.name) === 0,
    );

    while (queue.length > 0) {
      const next = queue.shift()!;
      sorted.push(next);
      for (const dependentName of dependents.get(next.name) ?? []) {
        const remaining = indegree.get(dependentName)! - 1;
        indegree.set(dependentName, remaining);
        if (remaining === 0) {
          // Insert in original position to keep deterministic ordering.
          const dependent = byName.get(dependentName)!;
          // Keep queue ordered by original index among ready items.
          const dependentIndex = this.initializers.indexOf(dependent);
          let insertAt = queue.length;
          for (let i = 0; i < queue.length; i++) {
            if (this.initializers.indexOf(queue[i]) > dependentIndex) {
              insertAt = i;
              break;
            }
          }
          queue.splice(insertAt, 0, dependent);
        }
      }
    }

    if (sorted.length !== this.initializers.length) {
      const unresolved = this.initializers
        .filter((i) => (indegree.get(i.name) ?? 0) > 0)
        .map((i) => i.name);
      throw new TypedError({
        type: ErrorType.INITIALIZER_VALIDATION,
        message: `Circular dependency detected among initializers: ${unresolved.join(" → ")}. Check each initializer's \`dependsOn\` list for a cycle.`,
      });
    }

    this.initializers = sorted;
  }

  /**
   * Render the resolved initializer dependency graph to the logs as a numbered list,
   * one line per initializer, with each dependency shown to the right. Leaf initializers
   * (no deps) render without an arrow.
   */
  private logInitializerDag() {
    const longestName = this.initializers.reduce(
      (max, i) => Math.max(max, i.name.length),
      0,
    );
    const digits = String(this.initializers.length).length;

    this.logger.debug("--- 🔗  Initializer dependency graph ---");
    this.initializers.forEach((i, idx) => {
      const num = String(idx + 1).padStart(digits, "0");
      const name = i.name.padEnd(longestName);
      const deps =
        i.dependsOn.length > 0 ? `  ← ${i.dependsOn.join(", ")}` : "";
      this.logger.debug(`  ${num}  ${name}${deps}`);
    });
  }

  /**
   * Assert that every initializer which claims an API namespace (via
   * `declaresAPIProperty`) has actually attached `api[initializer.name]`.
   * Closes the silent-drift gap between TypeScript module augmentation
   * and runtime property assignment — a missing namespace becomes a fast,
   * loud startup failure instead of a confusing `Cannot read property of
   * undefined` deep inside a request handler.
   *
   * Initializers excluded from the current `runMode` are skipped during the
   * `start` phase since their `start()` method never ran.
   */
  private validateInitializerProperties(phase: "initialize" | "start") {
    const missing: string[] = [];
    for (const initializer of this.initializers) {
      if (initializer.declaresAPIProperty === false) continue;
      if (phase === "start" && !initializer.runModes.includes(this.runMode)) {
        continue;
      }
      if (this[initializer.name] == null) {
        missing.push(initializer.name);
      }
    }
    if (missing.length > 0) {
      throw new TypedError({
        type: ErrorType.INITIALIZER_VALIDATION,
        message:
          `Initializers did not attach their namespace to api after the ${phase} phase: ` +
          `${missing.join(", ")}. Each initializer must either return a namespace object ` +
          `from initialize() (and/or populate it in start()), or set declaresAPIProperty = false.`,
      });
    }
  }
}
