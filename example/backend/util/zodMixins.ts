import { createSchemaFactory } from "drizzle-orm/zod";
import { zIdOrModel } from "keryx";
import { z } from "zod";
import { type Message, messages } from "../schema/messages";
import { type User, users } from "../schema/users";

// Create schema factory with Zod v4 instance for drizzle-orm/zod compatibility
const { createSelectSchema } = createSchemaFactory({ zodInstance: z });

/**
 * Zod schema generated from Drizzle users table.
 * Automatically stays in sync with the database schema.
 */
export const zUserSchema = createSelectSchema(users);

/**
 * Type guard to check if a value is a valid User object.
 */
export function isUser(val: unknown): val is User {
  return zUserSchema.safeParse(val).success;
}

/**
 * Accepts either a user_id (string/number) or a User object.
 * Resolves to a full User via async transform if ID is provided.
 */
export function zUserIdOrModel() {
  return zIdOrModel(users, zUserSchema as z.ZodType<User>, isUser, "User");
}

/**
 * Zod schema generated from Drizzle messages table.
 * Automatically stays in sync with the database schema.
 */
export const zMessageSchema = createSelectSchema(messages);

/**
 * Type guard to check if a value is a valid Message object.
 */
export function isMessage(val: unknown): val is Message {
  return zMessageSchema.safeParse(val).success;
}

/**
 * Accepts either a message_id (string/number) or a Message object.
 * Resolves to a full Message via async transform if ID is provided.
 */
export function zMessageIdOrModel() {
  return zIdOrModel(
    messages,
    zMessageSchema as z.ZodType<Message>,
    isMessage,
    "Message",
  );
}
