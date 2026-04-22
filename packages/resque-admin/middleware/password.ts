import { type ActionMiddleware, ErrorType, TypedError } from "keryx";
import { config } from "keryx/config";

/**
 * Middleware that validates a password input against `config.resqueAdmin.password`.
 * Rejects with 500 if no password is configured, or 401 if the password is wrong.
 */
export const ResqueAdminPasswordMiddleware: ActionMiddleware = {
  runBefore: async (params: { password?: string }) => {
    const configuredPassword = (
      config as unknown as { resqueAdmin?: { password?: string } }
    ).resqueAdmin?.password;

    if (!configuredPassword) {
      throw new TypedError({
        message:
          "Resque admin password is not configured. Set config.resqueAdmin.password.",
        type: ErrorType.CONFIG_ERROR,
      });
    }

    if (!params.password || params.password !== configuredPassword) {
      throw new TypedError({
        message: "Invalid resque admin password",
        type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
      });
    }
  },
};
