import { count, desc, eq, lt } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
  RateLimitMiddleware,
} from "keryx";
import { z } from "zod";
import { SessionMiddleware } from "../middleware/session";
import { serializeMessage } from "../ops/MessageOps";
import { type Message, messages } from "../schema/messages";
import { users } from "../schema/users";
import { zMessageIdOrModel } from "../util/zodMixins";
import type { SessionImpl } from "./session";

export class MessageCrete implements Action {
  name = "message:create";
  description =
    "Create a new chat message as the currently authenticated user. The message is persisted to the database and broadcast in real-time to all connected users via the 'messages' PubSub channel. Requires an active session. Returns the created message with its ID and timestamps.";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/message", method: HTTP_METHOD.PUT };
  inputs = z.object({
    body: z
      .string()
      .min(1, "Message body is required")
      .max(1000, "Message must be less than 1000 characters")
      .describe("The message body"),
  });

  async run(
    params: ActionParams<MessageCrete>,
    connection: Connection<SessionImpl>,
  ) {
    const userId = connection!.session!.data.userId!;

    const [message] = await api.db.db
      .insert(messages)
      .values({ body: params.body, user_id: userId })
      .returning();

    const [user] = await api.db.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    await api.pubsub.broadcast(
      "messages",
      { message: serializeMessage(message, user.name) },
      `user:${userId}`,
    );

    return { message: serializeMessage(message) };
  }
}

export class MessagesList implements Action {
  name = "messages:list";
  description =
    "List chat messages in reverse chronological order (newest first) with pagination. Each message includes the author's name, message body, and timestamps. Requires an active session. Use 'limit' (1-100, default 10) and 'page' (default 1) to paginate through results.";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/messages/list", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 10 });

  async run(
    params: ActionParams<MessagesList>,
    _connection: Connection<SessionImpl>,
  ) {
    const result = await paginate(
      api.db.db
        .select({
          id: messages.id,
          body: messages.body,
          createdAt: messages.createdAt,
          updatedAt: messages.updatedAt,
          user_id: messages.user_id,
          user_name: users.name,
        })
        .from(messages)
        .orderBy(desc(messages.id))
        .leftJoin(users, eq(users.id, messages.user_id)),
      api.db.db.select({ count: count() }).from(messages),
      params,
    );

    return {
      messages: (result.data as (Message & { user_name: string | null })[]).map(
        (m) => serializeMessage(m, m.user_name ? m.user_name : undefined),
      ),
      pagination: result.pagination,
    };
  }
}

export class MessageView implements Action {
  name = "message:view";
  description =
    "Retrieve a single message by its ID. Returns the message body, author name, and timestamps. Requires an active session. The 'message' parameter accepts a numeric message ID.";
  middleware = [RateLimitMiddleware, SessionMiddleware];
  web = { route: "/message/:message", method: HTTP_METHOD.GET };
  inputs = z.object({
    message: zMessageIdOrModel(),
  });

  async run(params: ActionParams<MessageView>) {
    const message = params.message;

    // Get the user name for the message
    const [user] = await api.db.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, message.user_id))
      .limit(1);

    return { message: serializeMessage(message, user?.name) };
  }
}

export class MessagesCleanup implements Action {
  name = "messages:cleanup";
  description =
    "Delete messages older than the specified age. Defaults to removing messages older than 24 hours. Also runs automatically as a background task every hour. Returns the count of deleted messages. The 'age' parameter is in milliseconds (minimum 1000).";
  middleware = [RateLimitMiddleware];
  task = { frequency: 1000 * 60 * 60, queue: "default" }; // run the task every hour
  inputs = z.object({
    age: z.coerce
      .number()
      .int()
      .min(1000)
      .default(1000 * 60 * 60 * 24), // 24 hours
  });
  async run(params: ActionParams<MessagesCleanup>) {
    const _messages = await api.db.db
      .delete(messages)
      .where(lt(messages.createdAt, new Date(Date.now() - params.age)))
      .returning();

    return {
      messagesDeleted: _messages.length,
    };
  }
}

export class MessagesHello implements Action {
  name = "messages:hello";
  description =
    "Post an automated greeting message containing the current server timestamp to the chat room as the system default user, and broadcast it to all connected clients. Also runs automatically as a background task every minute. Returns the message body text.";
  middleware = [RateLimitMiddleware];
  task = { frequency: 1000 * 60, queue: "default" }; // run the task every minute

  async run() {
    const [message] = await api.db.db
      .insert(messages)
      .values({
        body: "Hello! The current time is " + new Date().toISOString(),
        user_id: api.application.defaultUser.id,
      })
      .returning();

    const serializedMessage = serializeMessage(
      message,
      api.application.defaultUser.name,
    );

    await api.pubsub.broadcast(
      "messages",
      { message: serializedMessage },
      `user:${api.application.defaultUser.id}`,
    );

    return { message: serializedMessage.body };
  }
}
