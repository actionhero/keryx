import { RUN_MODE } from "./../api";

/**
 * Abstract base class for lifecycle components. Initializers are discovered automatically
 * and run in priority order during the framework's initialize → start → stop phases.
 * Each initializer typically extends the `API` interface via module augmentation and
 * returns its namespace object from `initialize()`.
 */
export abstract class Initializer {
  /** The unique name of this initializer (also used as the key on the `api` object). */
  name: string;
  /** Priority order for `initialize()`. Lower values run first. Default: 1000; core initializers use < 1000. */
  loadPriority: number;
  /** Priority order for `start()`. Lower values run first. Default: 1000; core initializers use < 1000. */
  startPriority: number;
  /** Priority order for `stop()`. Lower values run first. Default: 1000; core initializers use < 1000. */
  stopPriority: number;
  /** Which run modes this initializer participates in. Defaults to both SERVER and CLI. */
  runModes: RUN_MODE[];
  /**
   * Whether this initializer attaches a property named `this.name` on the `api` singleton.
   * Runtime validation in `API.initialize()` and `API.start()` will fail if the declared
   * property is missing. Default: `true`. Set to `false` for initializers that intentionally
   * don't augment the `API` interface.
   */
  declaresAPIProperty: boolean;

  constructor(name: string) {
    this.name = name;
    this.loadPriority = 1000;
    this.startPriority = 1000;
    this.stopPriority = 1000;
    this.runModes = [RUN_MODE.SERVER, RUN_MODE.CLI];
    this.declaresAPIProperty = true;
  }

  /**
   * Called during the `initialize` phase. Return a namespace object to attach to `api[this.name]`.
   * @returns The namespace object (e.g., `{ actions, enqueue, ... }`) that gets set on `api`.
   */
  async initialize?(): Promise<any>;

  /**
   * Called during the `start` phase. Connect to external services, bind ports, start workers.
   */
  async start?(): Promise<any>;

  /**
   * Called during the `stop` phase. Disconnect from services, release resources, stop workers.
   */
  async stop?(): Promise<any>;
}

export type InitializerSortKeys =
  | "loadPriority"
  | "startPriority"
  | "stopPriority";
