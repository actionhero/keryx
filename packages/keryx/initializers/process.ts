import { logger } from "../api";
import { Initializer } from "../classes/Initializer";
import { config } from "../config";

const namespace = "process";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Process["initialize"]>>;
  }
}

export class Process extends Initializer {
  constructor() {
    super(namespace);
  }

  async initialize() {
    const name = config.process.name;
    const pid = process.pid;
    logger.info(`Initializing process: ${name}, pid: ${pid}`);
    return { name, pid };
  }
}
