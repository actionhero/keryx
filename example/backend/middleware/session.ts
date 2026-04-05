import {
  type ActionMiddleware,
  Connection,
  ErrorType,
  TypedError,
} from "keryx";
import type { SessionImpl } from "../actions/session";

export const SessionMiddleware: ActionMiddleware = {
  runBefore: async (_params, connection: Connection<SessionImpl>) => {
    if (!connection.session || !connection.session.data.userId) {
      throw new TypedError({
        message: "Session not found",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }
  },
};
