import {
  type ActionMiddleware,
  type Connection,
  config,
  ErrorType,
  TypedError,
} from "keryx";
import type { AdminResolveRole, AdminRole } from "../util/roles";

/** What an action needs in order to run. */
export type AdminAccess = "read" | "write";

/**
 * Where the resolved role is cached for the duration of a request, so the read gate and
 * the action body don't each pay for the lookup.
 */
const ROLE_METADATA_KEY = "adminRole";

/**
 * Read the role resolved earlier in this request by {@link createAdminAuthMiddleware}.
 *
 * @param connection - The live connection.
 * @returns The caller's role, or `undefined` when no admin middleware has run.
 */
export function resolvedRole(connection?: Connection): AdminRole | undefined {
  const cached = connection?.metadata?.[ROLE_METADATA_KEY];
  return cached === "full" || cached === "read-only" ? cached : undefined;
}

/**
 * Build the middleware that gates every admin action.
 *
 * Three checks, in order:
 *
 * 1. When `config.admin.enabled` is false, fail as if the route doesn't exist (404).
 *    Turning the dashboard off shouldn't advertise that it was ever there.
 * 2. Resolve the caller's role. No role means no access (401).
 * 3. Write actions require `full`; `read-only` callers are refused (403).
 *
 * The role is resolved once per request and cached on `connection.metadata`, so actions
 * can branch on it — the table list reports the caller's role so the UI knows whether to
 * render edit controls — without a second lookup.
 *
 * @param resolveRole - The app's role resolver.
 * @param access - Whether the guarded action reads or writes.
 * @returns Middleware for an action's `middleware` array.
 */
export function createAdminAuthMiddleware(
  resolveRole: AdminResolveRole,
  access: AdminAccess,
): ActionMiddleware {
  return {
    runBefore: async (_params, connection: Connection) => {
      if (!config.admin.enabled) {
        throw new TypedError({
          message: "Admin dashboard is not enabled",
          type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
        });
      }

      const role = await resolveRole(connection);

      if (!role) {
        throw new TypedError({
          message: "Not authorized to access the admin dashboard",
          type: ErrorType.CONNECTION_SESSION_NOT_FOUND,
        });
      }

      if (access === "write" && role !== "full") {
        throw new TypedError({
          message: `Admin role "${role}" cannot modify data`,
          // The framework's only 403; the CHANNEL in the name predates its use by
          // actions, and the CSRF plugin leans on it the same way.
          type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
        });
      }

      connection.metadata[ROLE_METADATA_KEY] = role;
    },
  };
}
