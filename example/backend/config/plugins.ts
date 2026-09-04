import { adminPlugin, roleFromUserColumn } from "@keryxjs/admin";
import { CsrfMiddleware, csrfPlugin } from "@keryxjs/csrf";
import { resqueAdminPlugin } from "@keryxjs/resque-admin";
import { sentryPlugin } from "@keryxjs/sentry";
import { tracingPlugin } from "@keryxjs/tracing";
import type { KeryxPlugin } from "keryx";
import { loadFromEnvIfSet } from "keryx";
import type { SessionImpl } from "../actions/session";
import { SessionMiddleware } from "../middleware/session";
import { users } from "../schema/users";

/**
 * Read a comma-separated email allowlist, e.g.
 * `ADMIN_FULL_EMAILS="me@example.com,you@example.com"`.
 *
 * Read per request rather than at module load. Admin requests are rare enough that the
 * cost is irrelevant, and it keeps the allowlist changeable without a redeploy.
 */
async function emailList(key: string) {
  const raw = await loadFromEnvIfSet(key, "");
  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export default {
  plugins: [
    tracingPlugin,
    sentryPlugin,
    resqueAdminPlugin,
    csrfPlugin({ tokenActionMiddleware: [SessionMiddleware] }),
    adminPlugin({
      /**
       * This example keys admin access off an email allowlist so it needs no extra
       * column. A real app would more likely add an `admin_role` column to `users` and
       * return `user.admin_role` directly — the helper is shaped for exactly that.
       *
       * Runs on every admin request, so revoking access takes effect immediately rather
       * than at the user's next login.
       */
      resolveRole: roleFromUserColumn<SessionImpl>({
        table: users,
        sessionKey: (session) => session.userId,
        role: async (user) => {
          const email = String(user.email ?? "").toLowerCase();
          if ((await emailList("ADMIN_FULL_EMAILS")).includes(email)) {
            return "full";
          }
          if ((await emailList("ADMIN_READ_ONLY_EMAILS")).includes(email)) {
            return "read-only";
          }
          return null;
        },
      }),
      columns: {
        // Never expose credentials, and let the database own the timestamps.
        users: {
          hidden: ["password_hash"],
          readOnly: ["created_at", "updated_at"],
        },
        messages: { readOnly: ["created_at", "updated_at"] },
      },
      // The dashboard can delete any row, so its writes are worth protecting. Only
      // writes: a CSRF guard on a read would push the token into a GET query string.
      writeMiddleware: [CsrfMiddleware],
    }),
  ] as KeryxPlugin[],
};
