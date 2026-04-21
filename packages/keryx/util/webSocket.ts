import type { ServerWebSocket } from "bun";
import { api, logger } from "../api";
import type { ActionParams } from "../classes/Action";
import { CHANNEL_NAME_PATTERN } from "../classes/Channel";
import type { Connection } from "../classes/Connection";
import { StreamingResponse } from "../classes/StreamingResponse";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import type {
  ClientSubscribeMessage,
  ClientUnsubscribeMessage,
} from "../initializers/pubsub";
import { buildErrorPayload } from "./webResponse";

export function validateChannelName(channel: string) {
  if (!CHANNEL_NAME_PATTERN.test(channel)) {
    throw new TypedError({
      message: `Invalid channel name`,
      type: ErrorType.CONNECTION_CHANNEL_VALIDATION,
    });
  }
}

export async function handleWebsocketAction(
  connection: Connection,
  ws: ServerWebSocket,
  formattedMessage: ActionParams<any>,
) {
  const params = (formattedMessage.params ?? {}) as Record<string, unknown>;

  const { response, error } = await connection.act(
    formattedMessage.action,
    params,
    "WEBSOCKET",
  );

  if (error) {
    ws.send(
      JSON.stringify({
        messageId: formattedMessage.messageId,
        error: { ...buildErrorPayload(error) },
      }),
    );
  } else if (response instanceof StreamingResponse) {
    const reader = response.stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        ws.send(
          JSON.stringify({
            messageId: formattedMessage.messageId,
            streaming: true,
            chunk: decoder.decode(value),
          }),
        );
      }
    } finally {
      try {
        ws.send(
          JSON.stringify({
            messageId: formattedMessage.messageId,
            streaming: false,
          }),
        );
      } catch (_e) {
        // Connection may already be closed (e.g., client disconnected mid-stream)
      }
      response.onClose?.();
    }
  } else {
    ws.send(
      JSON.stringify({
        messageId: formattedMessage.messageId,
        response: { ...response },
      }),
    );
  }
}

export async function handleWebsocketSubscribe(
  connection: Connection,
  ws: ServerWebSocket,
  formattedMessage: ClientSubscribeMessage,
) {
  try {
    validateChannelName(formattedMessage.channel);

    // Check subscription limit
    const maxSubs = config.server.web.websocket.maxSubscriptions;
    if (maxSubs > 0 && connection.subscriptions.size >= maxSubs) {
      throw new TypedError({
        message: `Too many subscriptions (max ${maxSubs})`,
        type: ErrorType.CONNECTION_CHANNEL_VALIDATION,
      });
    }

    // Ensure session is loaded before checking authorization
    if (!connection.sessionLoaded) {
      await connection.loadSession();
    }

    // Check channel authorization middleware
    await api.channels.authorizeSubscription(
      formattedMessage.channel,
      connection,
    );

    connection.subscribe(formattedMessage.channel);
    await api.channels.addPresence(formattedMessage.channel, connection);
    ws.send(
      JSON.stringify({
        messageId: formattedMessage.messageId,
        subscribed: { channel: formattedMessage.channel },
      }),
    );
  } catch (e) {
    const error =
      e instanceof TypedError
        ? e
        : new TypedError({
            message: `${e}`,
            type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
            cause: e,
          });
    ws.send(
      JSON.stringify({
        messageId: formattedMessage.messageId,
        error: buildErrorPayload(error),
      }),
    );
  }
}

export async function handleWebsocketUnsubscribe(
  connection: Connection,
  ws: ServerWebSocket,
  formattedMessage: ClientUnsubscribeMessage,
) {
  try {
    validateChannelName(formattedMessage.channel);

    // Remove presence before unsubscribing (needs subscription still active for key resolution)
    try {
      await api.channels.removePresence(formattedMessage.channel, connection);
    } catch (e) {
      logger.error(`Error removing presence: ${e}`);
    }

    connection.unsubscribe(formattedMessage.channel);

    // Call channel middleware unsubscription hooks (for cleanup/presence)
    try {
      await api.channels.handleUnsubscription(
        formattedMessage.channel,
        connection,
      );
    } catch (e) {
      // Log but don't fail the unsubscription
      logger.error(`Error in channel unsubscription hook: ${e}`);
    }

    ws.send(
      JSON.stringify({
        messageId: formattedMessage.messageId,
        unsubscribed: { channel: formattedMessage.channel },
      }),
    );
  } catch (e) {
    const error =
      e instanceof TypedError
        ? e
        : new TypedError({
            message: `${e}`,
            type: ErrorType.CONNECTION_CHANNEL_VALIDATION,
            cause: e,
          });
    ws.send(
      JSON.stringify({
        messageId: formattedMessage.messageId,
        error: buildErrorPayload(error),
      }),
    );
  }
}
