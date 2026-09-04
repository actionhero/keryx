import { eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { api, type Connection } from "keryx";
import { toActionError } from "./dbErrors";

/**
 * What a caller may do. `read-only` can browse and filter; `full` can also create,
 * update, and delete. `null` means no access at all.
 */
export type AdminRole = "read-only" | "full";

/**
 * Decides a caller's role. Deliberately application-specific: how you identify an admin
 * is a property of your schema, not of this plugin. Return `null` to deny access.
 *
 * Receives the live connection, so it can read the session, headers, or anything else
 * the request carries — and it runs on every admin request, so a revoked admin loses
 * access immediately rather than at their next login.
 */
export type AdminResolveRole = (
  connection: Connection,
) => Promise<AdminRole | null> | AdminRole | null;

type Operand = Parameters<typeof eq<PgColumn>>[1];

export type RoleFromUserColumnOptions<TSession> = {
  /** The table holding your users. */
  table: PgTable;
  /** Column to match the session value against. Defaults to the table's `id` column. */
  idColumn?: PgColumn;
  /** Pulls the user's id out of the session. Return undefined for anonymous callers. */
  sessionKey: (session: TSession) => string | number | undefined;
  /**
   * Maps a loaded user row to a role. Return `null` to deny access. May be async, for
   * mappings that need to consult something beyond the row itself.
   */
  role: (
    user: Record<string, unknown>,
  ) => Promise<AdminRole | null> | AdminRole | null;
};

/**
 * Build an {@link AdminResolveRole} that loads the caller's user row and maps a column
 * to a role. Covers the common case — an `is_admin` flag or an `admin_role` column —
 * without hand-rolling the session lookup and query.
 *
 * ```ts
 * roleFromUserColumn<SessionImpl>({
 *   table: users,
 *   sessionKey: (session) => session.userId,
 *   role: (user) => (user.admin_role === "full" ? "full" : user.admin_role === "read-only" ? "read-only" : null),
 * })
 * ```
 *
 * Reach past this helper and write the callback yourself when roles come from somewhere
 * a single row lookup can't answer, like a join table or an external service.
 *
 * @param options - Table, session accessor, and the column-to-role mapping.
 * @returns A resolver suitable for `adminPlugin({ resolveRole })`.
 */
export function roleFromUserColumn<TSession>(
  options: RoleFromUserColumnOptions<TSession>,
): AdminResolveRole {
  return async (connection: Connection) => {
    const session = connection.session?.data as TSession | undefined;
    if (!session) return null;

    const id = options.sessionKey(session);
    if (id === undefined || id === null) return null;

    const idColumn =
      options.idColumn ??
      (options.table as unknown as Record<string, PgColumn>).id;
    if (!idColumn) return null;

    let user: Record<string, unknown> | undefined;
    try {
      [user] = await api.db.db
        .select()
        .from(options.table)
        .where(eq(idColumn, id as Operand))
        .limit(1);
    } catch (error) {
      // This runs in middleware, before any action-level error handling. Without
      // wrapping, a driver failure would send Drizzle's message — the full SQL plus
      // the caller's session id — straight to the client.
      throw toActionError(error, "resolve admin role");
    }

    if (!user) return null;

    return options.role(user);
  };
}
