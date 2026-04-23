import { eq } from "drizzle-orm";
import {
  Action,
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
import {
  hashPassword,
  serializePublicUser,
  serializeUser,
} from "../ops/UserOps";
import { users } from "../schema/users";
import { zUserIdOrModel } from "../util/zodMixins";

export class UserCreate implements Action {
  name = "user:create";
  description =
    "Register a new user account with a name, email, and password. The email must be unique across all users (case-insensitive). Password must be at least 8 characters and is stored securely as a hash. Returns the created user's profile (ID, name, email, timestamps). Does not require an existing session.";
  mcp = { tool: false, isSignupAction: true };
  middleware = [RateLimitMiddleware];
  web = { route: "/user", method: HTTP_METHOD.PUT };
  inputs = z.object({
    name: z
      .string()
      .min(3, "This field is required and must be at least 3 characters long")
      .max(256, "Name must be less than 256 characters")
      .describe("The user's name"),
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
        .max(256, "Password must be less than 256 characters")
        .describe("The user's password"),
    ),
  });

  async run(params: ActionParams<UserCreate>) {
    const [existingUser] = await api.db.db
      .select()
      .from(users)
      .where(eq(users.email, params.email))
      .limit(1);

    if (existingUser) {
      throw new TypedError({
        message: "User already exists",
        type: ErrorType.ACTION_VALIDATION,
      });
    }

    const [user] = await api.db.db
      .insert(users)
      .values({
        name: params.name,
        email: params.email,
        password_hash: await hashPassword(params.password),
      })
      .returning();

    return { user: serializeUser(user) };
  }
}

export class UserEdit implements Action {
  name = "user:edit";
  description =
    "Update the currently authenticated user's profile. All fields are optional — only provided fields will be updated. You can change the user's name, email, and/or password. Requires an active session. Returns the updated user profile.";
  web = { route: "/user", method: HTTP_METHOD.POST };
  middleware = [RateLimitMiddleware, SessionMiddleware];
  inputs = z.object({
    name: z.string().min(1).max(256).optional(),
    email: z.string().email().toLowerCase().optional(),
    password: secret(z.string().min(8).max(256).optional()),
  });

  async run(params: ActionParams<UserEdit>, connection: Connection) {
    const { name, email, password } = params;
    const updates = {} as Record<string, string>;
    if (name) updates.name = name;
    if (email) updates.email = email;
    if (password) updates.password_hash = await hashPassword(password);

    const [user] = await api.db.db
      .update(users)
      .set(updates)
      .where(eq(users.id, connection.session!.data.userId))
      .returning();

    return { user: serializeUser(user) };
  }
}

export class UserView implements Action {
  name = "user:view";
  description =
    "Retrieve another user's public profile by their user ID. Returns public information only (ID, name, timestamps) — does not expose email or other private fields. Requires an active session.";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/user/:user", method: HTTP_METHOD.GET };
  inputs = z.object({
    user: zUserIdOrModel(),
  });

  async run(params: ActionParams<UserView>) {
    // params.user is already a resolved User object
    return { user: serializePublicUser(params.user) };
  }
}
