import path from "path";
import { api, logger, RUN_MODE } from "../api";
import { Initializer } from "../classes/Initializer";
import type { Server } from "../classes/Server";
import { config } from "../config";
import { formatLoadedMessage } from "../util/config";
import { globLoader } from "../util/glob";

const namespace = "servers";

declare module "../classes/API" {
  export interface API {
    [namespace]: Awaited<ReturnType<Servers["initialize"]>>;
  }
}

export class Servers extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["actions"];
    this.runModes = [RUN_MODE.SERVER];
  }

  async initialize() {
    // Load framework servers from the package directory
    const frameworkServers = await globLoader<Server<any>>(
      path.join(api.packageDir, "servers"),
    );

    // Load plugin servers
    const pluginServers: Server<any>[] = [];
    for (const plugin of config.plugins) {
      if (plugin.servers) {
        for (const ServerClass of plugin.servers) {
          pluginServers.push(new ServerClass());
        }
      }
    }

    // Load user project servers (if rootDir differs from packageDir)
    let userServers: Server<any>[] = [];
    if (api.rootDir !== api.packageDir) {
      try {
        userServers = await globLoader<Server<any>>(
          path.join(api.rootDir, "servers"),
        );
      } catch {
        // user project may not have servers, that's fine
      }
    }

    const servers = [...frameworkServers, ...pluginServers, ...userServers];

    for (const server of servers) {
      await server.initialize();
    }

    logger.info(
      formatLoadedMessage("servers", {
        core: frameworkServers.length,
        plugin: pluginServers.length,
        user: userServers.length,
      }),
    );

    return { servers };
  }

  async start() {
    const { servers } = api[namespace];

    for (const server of servers) {
      await server.start();
    }
  }

  async stop() {
    const { servers } = api[namespace];

    for (const server of servers) {
      await server.stop();
    }
  }
}
