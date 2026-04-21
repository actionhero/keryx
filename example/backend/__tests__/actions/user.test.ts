import { describe, expect, test } from "bun:test";
import { type ActionResponse, config, logger } from "keryx";
import type { SessionCreate } from "../../actions/session";
import type { UserCreate, UserEdit, UserView } from "../../actions/user";
import { createTestSession, createTestUser, useTestServer } from "./../setup";

const getUrl = useTestServer({ clearDatabase: true });

describe("user:create", () => {
  test("user can be created", async () => {
    const res = await fetch(getUrl() + "/api/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mario Mario",
        email: "mario@example.com",
        password: "mushroom1",
      }),
    });
    const response = (await res.json()) as ActionResponse<UserCreate>;
    expect(res.status).toBe(200);

    expect(response.user.id).toEqual(1);
    expect(response.user.email).toEqual("mario@example.com");
  });

  test("email must be unique", async () => {
    const res = await fetch(getUrl() + "/api/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mario Mario",
        email: "mario@example.com",
        password: "mushroom1",
      }),
    });
    const response = (await res.json()) as ActionResponse<UserCreate>;
    expect(res.status).toBe(500);
    expect(response.error?.message.toLowerCase()).toMatch(
      /user already exists/,
    );
  });

  test("validation failures return the proper key", async () => {
    const res = await fetch(getUrl() + "/api/user", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        email: "y",
        password: "z",
      }),
    });
    const response = (await res.json()) as ActionResponse<UserCreate>;
    expect(res.status).toBe(406);
    expect(response.error?.message.toLowerCase()).toMatch(
      /this field is required and must be at least 3 characters long/,
    );
    expect(response.error?.key).toEqual("name");
    expect(response.error?.value).toEqual("x");
  });

  test("secret fields are redacted in logs", async () => {
    // Mock the logger to capture log messages
    const originalInfo = logger.info;
    const logMessages: string[] = [];
    logger.info = (message: string) => {
      logMessages.push(message);
    };

    try {
      const formData = new FormData();
      formData.append("name", "Test User");
      formData.append("email", "test@example.com");
      formData.append("password", "secretpassword123");

      await fetch(getUrl() + "/api/user", {
        method: "PUT",
        body: formData,
      });

      // Find the log message that contains the action execution
      const actionLogMessage = logMessages.find(
        (msg) => msg.includes("[ACTION:") && msg.includes("user:create"),
      );

      expect(actionLogMessage).toBeDefined();
      expect(actionLogMessage).toContain('"name":"Test User"');
      expect(actionLogMessage).toContain('"email":"test@example.com"');
      expect(actionLogMessage).toContain('"password":"[[secret]]"');
      expect(actionLogMessage).not.toContain('"password":"secretpassword123"');
    } finally {
      // Restore original logger
      logger.info = originalInfo;
    }
  });
});

describe("user:edit", () => {
  test("it fails without a session", async () => {
    const res = await fetch(getUrl() + "/api/user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new name" }),
    });
    const response = (await res.json()) as ActionResponse<UserEdit>;
    expect(res.status).toBe(401);
    expect(response.error?.message).toMatch(/Session not found/);
  });

  test("the user can be updated", async () => {
    const sessionRes = await createTestSession(getUrl());
    const sessionResponse =
      (await sessionRes.json()) as ActionResponse<SessionCreate>;
    expect(sessionRes.status).toBe(200);
    const sessionId = sessionResponse.session.id;

    const res = await fetch(getUrl() + "/api/user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${config.session.cookieName}=${sessionId}`,
      },
      body: JSON.stringify({ name: "new name" }),
    });
    const response = (await res.json()) as ActionResponse<UserEdit>;
    expect(res.status).toBe(200);
    expect(response.user.name).toEqual("new name");
    expect(response.user.email).toEqual("mario@example.com");
    expect(sessionResponse.user.updatedAt).toBeLessThan(
      response.user.updatedAt,
    );
  });
});

describe("user:view", () => {
  test("it fails without a session", async () => {
    const res = await fetch(getUrl() + "/api/user/1", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    const response = (await res.json()) as ActionResponse<UserView>;
    expect(res.status).toBe(401);
    expect(response.error?.message).toMatch(/Session not found/);
  });

  test("user can view themselves", async () => {
    // Create a user first
    await createTestUser(getUrl(), {
      name: "Luigi Mario",
      email: "luigi@example.com",
    });

    // Create a session
    const sessionRes = await createTestSession(getUrl(), {
      email: "luigi@example.com",
    });
    const sessionResponse =
      (await sessionRes.json()) as ActionResponse<SessionCreate>;
    expect(sessionRes.status).toBe(200);
    const sessionId = sessionResponse.session.id;
    const userId = sessionResponse.user.id;

    // View the user
    const res = await fetch(getUrl() + `/api/user/${userId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${config.session.cookieName}=${sessionId}`,
      },
    });
    const response = (await res.json()) as ActionResponse<UserView>;
    expect(res.status).toBe(200);
    expect(response.user.id).toEqual(userId);
    expect(response.user.name).toEqual("Luigi Mario");
    // Email should not be in public user data
    expect((response.user as Record<string, unknown>)["email"]).toBeUndefined();
  });

  test("user can view another user (public information only)", async () => {
    // Create two users
    await createTestUser(getUrl(), {
      name: "Peach Toadstool",
      email: "peach@example.com",
    });

    // Create a session for Peach
    const sessionRes = await createTestSession(getUrl(), {
      email: "peach@example.com",
    });
    const sessionResponse =
      (await sessionRes.json()) as ActionResponse<SessionCreate>;
    expect(sessionRes.status).toBe(200);
    const sessionId = sessionResponse.session.id;

    // View a different user (id 1, which should exist from earlier tests)
    const res = await fetch(getUrl() + "/api/user/1", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${config.session.cookieName}=${sessionId}`,
      },
    });
    const response = (await res.json()) as ActionResponse<UserView>;
    expect(res.status).toBe(200);
    expect(response.user.id).toEqual(1);
    expect(response.user.name).toBeDefined();
    expect(typeof response.user.name).toBe("string");
    // Email should not be in public user data
    expect((response.user as Record<string, unknown>)["email"]).toBeUndefined();
  });

  test("fails with invalid user id format", async () => {
    // Create a session
    const sessionRes = await createTestSession(getUrl(), {
      email: "peach@example.com",
    });
    const sessionResponse =
      (await sessionRes.json()) as ActionResponse<SessionCreate>;
    expect(sessionRes.status).toBe(200);
    const sessionId = sessionResponse.session.id;

    // Try to view with invalid id
    const res = await fetch(getUrl() + "/api/user/invalid", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${config.session.cookieName}=${sessionId}`,
      },
    });
    const response = (await res.json()) as ActionResponse<UserView>;
    expect(res.status).toBe(406);
    expect(response.error?.key).toEqual("user");
  });

  test("fails when user not found", async () => {
    // Create a session
    const sessionRes = await createTestSession(getUrl(), {
      email: "peach@example.com",
    });
    const sessionResponse =
      (await sessionRes.json()) as ActionResponse<SessionCreate>;
    expect(sessionRes.status).toBe(200);
    const sessionId = sessionResponse.session.id;

    // Try to view non-existent user
    const res = await fetch(getUrl() + "/api/user/99999", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${config.session.cookieName}=${sessionId}`,
      },
    });
    const response = (await res.json()) as ActionResponse<UserView>;
    expect(res.status).toBe(500); // CONNECTION_ACTION_RUN returns 500
    expect(response.error?.message).toMatch(/User with id 99999 not found/);
  });
});
