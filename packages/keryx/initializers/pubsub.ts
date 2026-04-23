import { api } from "../api";
import { Initializer } from "../classes/Initializer";
import { config } from "../config";
import pkg from "../package.json";

const namespace = "pubsub";
const redisPubSubChannel = `keryx:pubsub:${pkg.name}`;

export type PubSubMessage = {
  channel: string;
  message: string;
  sender: string;
};

export type ClientSubscribeMessage = {
  messageType: "subscribe";
  messageId: string | number;
  channel: string;
};

export type ClientUnsubscribeMessage = {
  messageType: "unsubscribe";
  messageId: string | number;
  channel: string;
};

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<PubSub["initialize"]>>;
  }
}

export class PubSub extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["redis", "connections"];
  }

  async initialize() {
    /**
     * Publish a message to all subscribers of a channel across the cluster via Redis PubSub.
     *
     * @param channel - The application-level channel name.
     * @param message - The message payload (will be JSON-serialized).
     * @param sender - Identifier of the sending connection. Defaults to `"unknown-sender"`.
     */
    async function broadcast(
      channel: string,
      message: any,
      sender = "unknown-sender",
    ) {
      const payload: PubSubMessage = { channel, message, sender };
      return api.redis.redis.publish(
        redisPubSubChannel,
        JSON.stringify(payload),
      );
    }

    return { broadcast };
  }

  async start() {
    if (api.redis.subscription) {
      await api.redis.subscription.subscribe(redisPubSubChannel);
      api.redis.subscription.on("message", this.handleMessage.bind(this));
    }
  }

  async stop() {
    if (api.redis.subscription) {
      api.redis.subscription.removeAllListeners("message");
      await api.redis.subscription.unsubscribe(redisPubSubChannel);
    }
  }

  /**
   * Redis subscription callback. Delivers the incoming PubSub message to all local
   * connections subscribed to the target channel, and forwards to MCP if enabled.
   */
  async handleMessage(
    _pubSubChannel: string,
    incomingMessage: string | Buffer,
  ) {
    const payload = JSON.parse(incomingMessage.toString()) as PubSubMessage;
    for (const connection of api.connections.connections.values()) {
      if (connection.subscriptions.has(payload.channel)) {
        connection.onBroadcastMessageReceived(payload);
      }
    }

    // Forward to MCP as notifications
    if (config.server.mcp.enabled && api.mcp?.sendNotification) {
      api.mcp.sendNotification(payload);
    }
  }
}
