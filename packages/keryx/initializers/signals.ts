import { api, logger } from "../api";
import { ExitCode } from "../classes/ExitCode";
import { Initializer } from "../classes/Initializer";
import { config } from "../config";

const namespace = "signals";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<Signals["initialize"]>>;
  }
}

export class Signals extends Initializer {
  constructor() {
    super(namespace);
  }

  async initialize() {
    process.once("SIGINT", async () => {
      await this.shuDown("SIGINT", ExitCode.success);
    });

    process.once("SIGKILL", async () => {
      await this.shuDown("SIGKILL", ExitCode.success);
    });

    return { stop: this.shuDown.bind(this) };
  }

  async shuDown(
    signal: string,
    exitCode: ExitCode,
    logging = true,
    finalMessage?: any,
  ) {
    if (logging) logger.warn(`Received ${signal}, shutting down...`);
    const timeout = setTimeout(this.onTimeout, config.process.shutdownTimeout);
    await api.stop();
    clearTimeout(timeout);
    if (logging) logger.warn("👋  Bye!");
    if (finalMessage) {
      if (exitCode === ExitCode.success) {
        console.log(finalMessage);
      } else {
        console.error(finalMessage);
      }
    }

    process.exit(exitCode);
  }

  async onTimeout() {
    logger.fatal(
      `Shutdown timeout reached after ${config.process.shutdownTimeout}ms, force-exiting now`,
    );
    process.exit(ExitCode.error);
  }
}
