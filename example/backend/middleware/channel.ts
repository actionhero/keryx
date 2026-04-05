import {
  type ChannelMiddleware,
  type Connection,
  ErrorType,
  TypedError,
} from "keryx";
import type { SessionImpl } from "../actions/session";

/**
 * Channel middleware that requires a valid session with a userId.
 * Use this middleware to protect channels that require authentication.
 *
 * Usage:
 * ```typescript
 * export class ProtectedChannel extends Channel {
 *   constructor() {
 *     super({
 *       name: "protected-channel",
 *       middleware: [SessionChannelMiddleware],
 *     });
 *   }
 * }
 * ```
 */
export const SessionChannelMiddleware: ChannelMiddleware = {
  runBefore: async (
    _channel: string,
    connection: Connection<SessionImpl>,
  ): Promise<void> => {
    if (!connection.session || !connection.session.data.userId) {
      throw new TypedError({
        message: "Authentication required to join this channel",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
  },
};
