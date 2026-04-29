import { eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  Connection,
  ErrorType,
  HTTP_METHOD,
  RateLimitMiddleware,
  secret,
  TypedError,
} from "keryx";
import { z } from "zod";
import { SessionMiddleware } from "../middleware/session";
import { checkPassword, serializeUser } from "../ops/UserOps";
import { users } from "../schema/users";

export type SessionImpl = { userId?: number };

export class SessionCreate implements Action {
  name = "session:create";
  description =
    "Sign in by providing an email and password. If credentials are valid, creates an authenticated session and returns the user's profile along with session details. This is the login action — call this before using any endpoints that require authentication.";
  mcp = { tool: false, isLoginAction: true };
  middleware = [RateLimitMiddleware];
  web = { route: "/session", method: HTTP_METHOD.PUT };
  inputs = z.object({
    email: z
      .string()
      .min(3, "This field is required and must be at least 3 characters long")
      .refine(
        (val) => val.includes("@") && val.includes("."),
        "This is not a valid email",
      )
      .transform((val) => val.toLowerCase())
      .describe("The user's email"),
    password: secret(
      z
        .string()
        .min(8, "Password must be at least 8 characters")
        .describe("The user's password"),
    ),
  });

  async run(
    params: ActionParams<SessionCreate>,
    connection: Connection<SessionImpl>,
  ) {
    const [user] = await api.db.db
      .select()
      .from(users)
      .where(eq(users.email, params.email));

    const passwordMatch = user
      ? await checkPassword(user, params.password)
      : false;
    if (!user || !passwordMatch) {
      throw new TypedError({
        message: "Invalid email or password",
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }

    await connection.updateSession({ userId: user.id });
    await connection.regenerateSession();

    return {
      user: serializeUser(user),
      session: connection.session!,
    };
  }
}

export class SessionDestroy implements Action {
  name = "session:destroy";
  description =
    "Sign out by destroying the current authenticated session. After calling this, the session token is invalidated and subsequent requests will be unauthenticated. Requires an active session. Returns {success: true} on success.";
  web = { route: "/session", method: HTTP_METHOD.DELETE };
  mcp = { tool: false };
  middleware = [RateLimitMiddleware, SessionMiddleware];

  async run(
    _params: ActionParams<SessionDestroy>,
    connection: Connection<SessionImpl>,
  ) {
    await api.session.destroy(connection);
    return { success: true };
  }
}
