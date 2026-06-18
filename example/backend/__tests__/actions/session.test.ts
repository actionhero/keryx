import { beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api } from "keryx";
import type { SessionCreate } from "../../actions/session";
import { hashPassword } from "../../ops/UserOps";
import { users } from "../../schema/users";
import { useTestServer } from "./../setup";

const getUrl = useTestServer({ clearDatabase: true });

beforeAll(async () => {
  await api.db.db.insert(users).values({
    name: "Mario Mario",
    email: "mario@example.com",
    password_hash: await hashPassword("mushroom1"),
  });
});

describe("session:create", () => {
  test("returns user when matched", async () => {
    const res = await fetch(getUrl() + "/api/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "mario@example.com",
        password: "mushroom1",
      }),
    });
    const response = (await res.json()) as ActionResponse<SessionCreate>;
    expect(res.status).toBe(200);

    expect(response.user.id).toEqual(1);
    expect(response.user.name).toEqual("Mario Mario");
    expect(response.session.createdAt).toBeGreaterThan(0);
    expect(response.session.data.userId).toEqual(response.user.id);
  });

  test("fails validation", async () => {
    const res = await fetch(getUrl() + "/api/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "foo",
        password: "validpassword123",
      }),
    });
    const response = (await res.json()) as ActionResponse<SessionCreate>;
    expect(res.status).toBe(406);
    expect(response.error?.message).toEqual("This is not a valid email");
  });

  test("fails when user is not found with generic error", async () => {
    const res = await fetch(getUrl() + "/api/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bowser@example.com",
        password: "password123",
      }),
    });
    const response = (await res.json()) as ActionResponse<SessionCreate>;
    expect(res.status).toBe(500);
    expect(response.error?.message).toEqual("Invalid email or password");
  });

  test("regenerates session ID on login to prevent session fixation", async () => {
    // First request to get a pre-login session cookie
    const preLoginRes = await fetch(getUrl() + "/api/status");
    const preLoginCookie = preLoginRes.headers.get("set-cookie");
    const preLoginSessionId = preLoginCookie?.split("=")[1]?.split(";")[0];
    expect(preLoginSessionId).toBeDefined();

    // Login with the pre-login cookie
    const loginRes = await fetch(getUrl() + "/api/session", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: `__session=${preLoginSessionId}`,
      },
      body: JSON.stringify({
        email: "mario@example.com",
        password: "mushroom1",
      }),
    });
    const loginResponse =
      (await loginRes.json()) as ActionResponse<SessionCreate>;
    expect(loginRes.status).toBe(200);

    // The session ID in the response body should differ from the pre-login one
    expect(loginResponse.session.id).not.toBe(preLoginSessionId);

    // The Set-Cookie header should contain the new session ID
    const postLoginCookie = loginRes.headers.get("set-cookie");
    const postLoginSessionId = postLoginCookie?.split("=")[1]?.split(";")[0];
    expect(postLoginSessionId).toBe(loginResponse.session.id);
    expect(postLoginSessionId).not.toBe(preLoginSessionId);
  });

  test("fails when passwords do not match with same generic error", async () => {
    const res = await fetch(getUrl() + "/api/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "mario@example.com",
        password: "wrongpassword123",
      }),
    });
    const response = (await res.json()) as ActionResponse<SessionCreate>;
    expect(res.status).toBe(500);
    expect(response.error?.message).toEqual("Invalid email or password");
  });
});

describe("session:destroy", () => {
  let session: ActionResponse<SessionCreate>["session"];

  beforeAll(async () => {
    const sessionRes = await fetch(getUrl() + "/api/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "mario@example.com",
        password: "mushroom1",
      }),
    });
    const sessionResponse =
      (await sessionRes.json()) as ActionResponse<SessionCreate>;
    session = sessionResponse.session;
  });

  test("successfully destroys a session", async () => {
    const res = await fetch(getUrl() + "/api/session", {
      method: "DELETE",
      headers: {
        Cookie: `${session.cookieName}=${session.id}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const response = (await res.json()) as { success: boolean };
    expect(res.status).toBe(200);
    expect(response.success).toBe(true);

    // Verify session is actually destroyed by trying to access a protected endpoint
    const userRes = await fetch(getUrl() + "/api/user/1", {
      method: "GET",
      headers: {
        Cookie: `${session.cookieName}=${session.id}`,
        "Content-Type": "application/json",
      },
    });
    expect(userRes.status).toBe(401);
  });

  test("fails without a session", async () => {
    const res = await fetch(getUrl() + "/api/session", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const response = (await res.json()) as { error?: { message: string } };
    expect(res.status).toBe(401);
    expect(response.error?.message).toMatch(/Session not found/);
  });
});
