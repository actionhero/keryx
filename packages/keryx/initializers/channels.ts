import path, { join } from "path";
import { api, logger } from "../api";
import type { Channel } from "../classes/Channel";
import type { Connection } from "../classes/Connection";
import { Initializer } from "../classes/Initializer";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import { formatLoadedMessage } from "../util/config";
import { globLoader } from "../util/glob";

const namespace = "channels";
const PRESENCE_KEY_PREFIX = "presence:";
const LUA_DIR = join(import.meta.dir, "..", "lua");

declare module "../classes/API" {
  export interface API {
    [namespace]: Awaited<ReturnType<Channels["initialize"]>>;
  }
}

export class Channels extends Initializer {
  private addPresenceLua = "";
  private removePresenceLua = "";
  private refreshPresenceLua = "";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super(namespace);
    this.loadPriority = 100;
    this.startPriority = 600;
    this.stopPriority = 50;
  }

  /**
   * Find a channel definition that matches the given channel name.
   * Returns undefined if no matching channel is found.
   */
  findChannel = (channelName: string): Channel | undefined => {
    return api.channels.channels.find((c: Channel) => c.matches(channelName));
  };

  /**
   * Authorize a connection to subscribe to a channel.
   * Runs all middleware and the channel's authorize method.
   * Throws TypedError if authorization fails.
   */
  authorizeSubscription = async (
    channelName: string,
    connection: Connection,
  ): Promise<void> => {
    const channel = this.findChannel(channelName);

    if (!channel) {
      throw new TypedError({
        message: `Channel not found: ${channelName}`,
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }

    // Run all middleware runBefore hooks
    for (const middleware of channel.middleware) {
      if (middleware.runBefore) {
        await middleware.runBefore(channelName, connection);
      }
    }

    // Run the channel's authorize method
    await channel.authorize(channelName, connection);
  };

  /**
   * Called when a connection unsubscribes from a channel.
   * Runs all middleware runAfter hooks.
   */
  handleUnsubscription = async (
    channelName: string,
    connection: Connection,
  ): Promise<void> => {
    const channel = this.findChannel(channelName);

    if (!channel) {
      return;
    }

    // Run all middleware runAfter hooks
    for (const middleware of channel.middleware) {
      if (middleware.runAfter) {
        await middleware.runAfter(channelName, connection);
      }
    }
  };

  /**
   * Record a connection's presence in a channel and broadcast a join event
   * if this is the first connection for that presence key.
   *
   * Redis keys:
   *   presence:{channelName} — Set of presence keys
   *   presence:{channelName}:{presenceKey} — Set of connection IDs
   */
  addPresence = async (
    channelName: string,
    connection: Connection,
  ): Promise<void> => {
    const channel = this.findChannel(channelName);
    const key = channel ? await channel.presenceKey(connection) : connection.id;

    const channelKey = `${PRESENCE_KEY_PREFIX}${channelName}`;
    const connectionSetKey = `${PRESENCE_KEY_PREFIX}${channelName}:${key}`;

    const added = await api.redis.redis.eval(
      this.addPresenceLua,
      2,
      connectionSetKey,
      channelKey,
      connection.id,
      key,
      config.channels.presenceTTL,
    );

    if (added === 1) {
      await api.pubsub.broadcast(
        channelName,
        JSON.stringify({ event: "join", presenceKey: key }),
        "presence",
      );
    }
  };

  /**
   * Remove a connection's presence from a channel and broadcast a leave event
   * if this was the last connection for that presence key.
   */
  removePresence = async (
    channelName: string,
    connection: Connection,
  ): Promise<void> => {
    const channel = this.findChannel(channelName);
    const key = channel ? await channel.presenceKey(connection) : connection.id;

    const channelKey = `${PRESENCE_KEY_PREFIX}${channelName}`;
    const connectionSetKey = `${PRESENCE_KEY_PREFIX}${channelName}:${key}`;

    const shouldLeave = await api.redis.redis.eval(
      this.removePresenceLua,
      2,
      connectionSetKey,
      channelKey,
      connection.id,
      key,
    );

    if (shouldLeave === 1) {
      await api.pubsub.broadcast(
        channelName,
        JSON.stringify({ event: "leave", presenceKey: key }),
        "presence",
      );
    }
  };

  /**
   * Returns the list of presence keys for members currently in the channel
   * across all server instances.
   */
  members = async (channelName: string): Promise<string[]> => {
    const channelKey = `${PRESENCE_KEY_PREFIX}${channelName}`;
    return api.redis.redis.smembers(channelKey);
  };

  /**
   * Refresh TTLs on all presence keys owned by local connections.
   * Called periodically by the heartbeat timer to prevent keys from
   * expiring while the server is still alive.
   */
  refreshPresence = async (): Promise<void> => {
    const keysToRefresh = new Set<string>();

    for (const connection of api.connections.connections.values()) {
      for (const channelName of connection.subscriptions) {
        const channel = this.findChannel(channelName);
        const key = channel
          ? await channel.presenceKey(connection)
          : connection.id;

        keysToRefresh.add(`${PRESENCE_KEY_PREFIX}${channelName}`);
        keysToRefresh.add(`${PRESENCE_KEY_PREFIX}${channelName}:${key}`);
      }
    }

    if (keysToRefresh.size === 0) return;

    const keys = [...keysToRefresh];
    await api.redis.redis.eval(
      this.refreshPresenceLua,
      keys.length,
      ...keys,
      config.channels.presenceTTL,
    );
  };

  /**
   * Clear all presence data. Useful for test cleanup.
   */
  clearPresence = async (): Promise<void> => {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await api.redis.redis.scan(
        cursor,
        "MATCH",
        `${PRESENCE_KEY_PREFIX}*`,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await api.redis.redis.del(...keys);
      }
    } while (cursor !== "0");
  };

  async initialize() {
    this.addPresenceLua = await Bun.file(
      join(LUA_DIR, "add-presence.lua"),
    ).text();
    this.removePresenceLua = await Bun.file(
      join(LUA_DIR, "remove-presence.lua"),
    ).text();
    this.refreshPresenceLua = await Bun.file(
      join(LUA_DIR, "refresh-presence.lua"),
    ).text();

    // Load plugin channels
    const pluginChannels: Channel[] = [];
    for (const plugin of config.plugins) {
      if (plugin.channels) {
        for (const ChannelClass of plugin.channels) {
          pluginChannels.push(new ChannelClass());
        }
      }
    }

    // Load user channels
    let userChannels: Channel[] = [];
    try {
      userChannels = await globLoader<Channel>(
        path.join(api.rootDir, "channels"),
      );
    } catch (e) {
      // channels directory may not exist, which is fine
      logger.debug(
        `No channels directory found or error loading channels: ${e}`,
      );
    }

    const channels = [...pluginChannels, ...userChannels];

    for (const c of channels) {
      if (!c.description) c.description = `A Channel: ${c.name}`;
    }

    logger.info(
      formatLoadedMessage("channels", {
        plugin: pluginChannels.length,
        user: userChannels.length,
      }),
    );

    return {
      channels,
      findChannel: this.findChannel,
      authorizeSubscription: this.authorizeSubscription,
      handleUnsubscription: this.handleUnsubscription,
      addPresence: this.addPresence,
      removePresence: this.removePresence,
      refreshPresence: this.refreshPresence,
      members: this.members,
      clearPresence: this.clearPresence,
    };
  }

  async start() {
    const intervalMs = config.channels.presenceHeartbeatInterval * 1000;
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.refreshPresence();
      } catch (e) {
        logger.error(`presence heartbeat error: ${e}`);
      }
    }, intervalMs);

    logger.info(
      `presence heartbeat started (interval=${config.channels.presenceHeartbeatInterval}s, ttl=${config.channels.presenceTTL}s)`,
    );
  }

  async stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
