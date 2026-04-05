import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api } from "keryx";
import type { SessionCreate } from "../../actions/session";
import { hashPassword } from "../../ops/UserOps";
import { users } from "../../schema/users";
import { HOOK_TIMEOUT, serverUrl } from "./../setup";

let url: string;

beforeAll(async () => {
  await api.start();
  url = serverUrl();
  await api.db.clearDatabase();
  await api.db.db.insert(users).values({
    name: "Mario Mario",
    email: "mario@example.com",
    password_hash: await hashPassword("mushroom1"),
  });
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("session:create", () => {
  test("returns user when matched", async () => {
    const res = await fetch(url + "/api/session", {
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
    const res = await fetch(url + "/api/session", {
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
    const res = await fetch(url + "/api/session", {
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

  test("fails when passwords do not match with same generic error", async () => {
    const res = await fetch(url + "/api/session", {
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
    const sessionRes = await fetch(url + "/api/session", {
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
    const res = await fetch(url + "/api/session", {
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
    const userRes = await fetch(url + "/api/user/1", {
      method: "GET",
      headers: {
        Cookie: `${session.cookieName}=${session.id}`,
        "Content-Type": "application/json",
      },
    });
    expect(userRes.status).toBe(401);
  });

  test("fails without a session", async () => {
    const res = await fetch(url + "/api/session", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const response = (await res.json()) as { error?: { message: string } };
    expect(res.status).toBe(401);
    expect(response.error?.message).toMatch(/Session not found/);
  });
});
