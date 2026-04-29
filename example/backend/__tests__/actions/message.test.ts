import { beforeAll, describe, expect, test } from "bun:test";
import type { CsrfTokenAction } from "@keryxjs/csrf";
import { type ActionResponse, api } from "keryx";
import type {
  MessageCreate,
  MessagesList,
  MessageView,
} from "../../actions/message";
import type { SessionCreate } from "../../actions/session";
import { messages } from "../../schema/messages";
import { createTestSession, createTestUser, useTestServer } from "./../setup";

const getUrl = useTestServer({ clearDatabase: true, clearRedis: true });

async function fetchCsrfToken(url: string, cookie: string): Promise<string> {
  const res = await fetch(url + "/api/csrf-token", {
    headers: { Cookie: cookie },
  });
  const body = (await res.json()) as ActionResponse<CsrfTokenAction>;
  return body.token;
}

describe("message:create", () => {
  let user: ActionResponse<SessionCreate>["user"];
  let session: ActionResponse<SessionCreate>["session"];
  let csrfToken: string;

  beforeAll(async () => {
    await createTestUser(getUrl());
    const sessionRes = await createTestSession(getUrl());
    const sessionResponse =
      (await sessionRes.json()) as ActionResponse<SessionCreate>;
    user = sessionResponse.user;
    session = sessionResponse.session;
    csrfToken = await fetchCsrfToken(
      getUrl(),
      `${session.cookieName}=${session.id}`,
    );
  });

  test("fails without a session", async () => {
    const res = await fetch(getUrl() + "/api/message", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello, world!" }),
    });
    expect(res.status).toBe(401);
    const response = (await res.json()) as ActionResponse<MessageCreate>;
    expect(response.error?.message).toEqual("Session not found");
  });

  test("fails without a valid session", async () => {
    const res = await fetch(getUrl() + "/api/message", {
      method: "PUT",
      headers: {
        Cookie: `${session.cookieName}=123`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: "Hello, world!" }),
    });
    expect(res.status).toBe(401);
    const response = (await res.json()) as ActionResponse<MessageCreate>;
    expect(response.error?.message).toEqual("Session not found");
  });

  test("messages can be created", async () => {
    const res = await fetch(getUrl() + "/api/message", {
      method: "PUT",
      headers: {
        Cookie: `${session.cookieName}=${session.id}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: "Hello, world!", csrfToken }),
    });
    expect(res.status).toBe(200);

    const response = (await res.json()) as ActionResponse<MessageCreate>;
    expect(response.message.body).toEqual("Hello, world!");
    expect(response.message.id).toBeGreaterThanOrEqual(1);
    expect(response.message.createdAt).toBeGreaterThan(0);
  });

  test("rejects message:create when CSRF token is missing", async () => {
    const res = await fetch(getUrl() + "/api/message", {
      method: "PUT",
      headers: {
        Cookie: `${session.cookieName}=${session.id}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: "no token" }),
    });
    expect(res.status).toBe(403);
  });

  describe("messages:list", () => {
    beforeAll(async () => {
      await api.db.db.delete(messages);

      for (const m of [
        "message 1",
        "message 2",
        "message 3",
        "message 4",
        "message 5",
      ]) {
        await api.db.db.insert(messages).values({
          body: m,
          user_id: user.id,
        });
      }
    });

    test("messages can be listed in the proper (reverse) order", async () => {
      const res = await fetch(getUrl() + "/api/messages/list", {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
          "Content-Type": "application/json",
        },
      });
      expect(res.status).toBe(200);

      const response = (await res.json()) as ActionResponse<MessagesList>;
      expect(response.messages.length).toEqual(5);
      expect(response.messages[0].body).toEqual("message 5");
      expect(response.messages[4].body).toEqual("message 1");
    });

    test("returns pagination metadata", async () => {
      const res = await fetch(getUrl() + "/api/messages/list", {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
          "Content-Type": "application/json",
        },
      });
      expect(res.status).toBe(200);

      const response = (await res.json()) as ActionResponse<MessagesList>;
      expect(response.pagination).toBeDefined();
      expect(response.pagination.page).toEqual(1);
      expect(response.pagination.limit).toEqual(10);
      expect(response.pagination.total).toEqual(5);
      expect(response.pagination.pages).toEqual(1);
    });

    test("limit and page can be used", async () => {
      const res = await fetch(getUrl() + "/api/messages/list?limit=2&page=2", {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
          "Content-Type": "application/json",
        },
      });
      expect(res.status).toBe(200);

      const response = (await res.json()) as ActionResponse<MessagesList>;
      expect(response.messages.length).toEqual(2);
      expect(response.messages[0].body).toEqual("message 3");
      expect(response.messages[1].body).toEqual("message 2");
      expect(response.pagination.page).toEqual(2);
      expect(response.pagination.pages).toEqual(3);
      expect(response.pagination.total).toEqual(5);
    });
  });

  describe("message:view", () => {
    let messageId: number;

    beforeAll(async () => {
      // Create a message for testing
      const [msg] = await api.db.db
        .insert(messages)
        .values({
          body: "Test message for viewing",
          user_id: user.id,
        })
        .returning();
      messageId = msg.id;
    });

    test("fails without a session", async () => {
      const res = await fetch(getUrl() + `/api/message/${messageId}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
      const response = (await res.json()) as ActionResponse<MessageView>;
      expect(response.error?.message).toEqual("Session not found");
    });

    test("can view a message by ID", async () => {
      const res = await fetch(getUrl() + `/api/message/${messageId}`, {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
          "Content-Type": "application/json",
        },
      });
      expect(res.status).toBe(200);

      const response = (await res.json()) as ActionResponse<MessageView>;
      expect(response.message.id).toEqual(messageId);
      expect(response.message.body).toEqual("Test message for viewing");
      expect(response.message.user_id).toEqual(user.id);
      expect(response.message.user_name).toEqual("Mario Mario");
    });

    test("includes user_name in response", async () => {
      const res = await fetch(getUrl() + `/api/message/${messageId}`, {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
          "Content-Type": "application/json",
        },
      });
      expect(res.status).toBe(200);

      const response = (await res.json()) as ActionResponse<MessageView>;
      expect(response.message.user_name).toBeDefined();
      expect(typeof response.message.user_name).toBe("string");
    });

    test("fails with invalid message id format", async () => {
      const res = await fetch(getUrl() + `/api/message/invalid`, {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
          "Content-Type": "application/json",
        },
      });
      expect(res.status).toBe(406);
      const response = (await res.json()) as ActionResponse<MessageView>;
      expect(response.error?.key).toEqual("message");
    });

    test("fails when message not found", async () => {
      const res = await fetch(getUrl() + `/api/message/99999`, {
        method: "GET",
        headers: {
          Cookie: `${session.cookieName}=${session.id}`,
          "Content-Type": "application/json",
        },
      });
      expect(res.status).toBe(500); // CONNECTION_ACTION_RUN returns 500
      const response = (await res.json()) as ActionResponse<MessageView>;
      expect(response.error?.message).toMatch(
        /Message with id 99999 not found/,
      );
    });
  });
});
