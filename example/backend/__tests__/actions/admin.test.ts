import { beforeAll, describe, expect, test } from "bun:test";
import { api, config } from "keryx";
import {
  createTestSession,
  createTestUser,
  DEFAULT_TEST_USER,
  useTestServer,
} from "./../setup";

const getUrl = useTestServer({ clearDatabase: true });

/** Session cookie for a logged-in user. */
async function login(): Promise<string> {
  await createTestUser(getUrl());
  const res = await createTestSession(getUrl());
  const cookie = (res.headers.get("set-cookie") ?? "").match(
    new RegExp(`${config.session.cookieName}=([^;]+)`),
  );
  if (!cookie) throw new Error("no session cookie");
  return `${config.session.cookieName}=${cookie[1]}`;
}

async function adminFetch(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const res = await fetch(`${getUrl()}/api/admin${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.cookie ? { Cookie: init.cookie } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("admin plugin wiring", () => {
  beforeAll(() => {
    // The example app's resolver keys off an env allowlist, read per request.
    process.env.ADMIN_FULL_EMAILS = DEFAULT_TEST_USER.email;
  });

  test("registers the dashboard and its actions", () => {
    const names = api.actions.actions
      .filter((a) => a.name.startsWith("admin:"))
      .map((a) => a.name)
      .sort();

    expect(names).toEqual([
      "admin:record:create",
      "admin:record:destroy",
      "admin:record:show",
      "admin:record:update",
      "admin:table:list",
      "admin:table:schema",
      "admin:tables",
      "admin:ui",
    ]);
  });

  test("serves the dashboard HTML", async () => {
    const res = await fetch(`${getUrl()}/api/admin`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("denies anonymous callers", async () => {
    expect((await adminFetch("/tables")).status).toBe(401);
  });

  test("denies a logged-in user who is not on the admin list", async () => {
    process.env.ADMIN_FULL_EMAILS = "someone-else@example.com";
    try {
      const cookie = await login();
      expect((await adminFetch("/tables", { cookie })).status).toBe(401);
    } finally {
      process.env.ADMIN_FULL_EMAILS = DEFAULT_TEST_USER.email;
    }
  });

  test("discovers the app's real tables through api.db.schema", async () => {
    const cookie = await login();
    const { status, body } = await adminFetch("/tables", { cookie });

    expect(status).toBe(200);
    expect(
      (body.tables as { name: string }[]).map((t) => t.name).sort(),
    ).toEqual(["messages", "users"]);
    expect(body.role).toBe("full");
  });

  test("hides password_hash from the users table", async () => {
    const cookie = await login();
    const { body } = await adminFetch("/tables/users/schema", { cookie });

    const columns = (body.columns as { name: string; writable: boolean }[]).map(
      (c) => c.name,
    );
    expect(columns).not.toContain("password_hash");
    expect(columns).toContain("email");
  });

  test("marks the timestamp columns read-only", async () => {
    const cookie = await login();
    const { body } = await adminFetch("/tables/users/schema", { cookie });

    const columns = body.columns as { name: string; writable: boolean }[];
    const writable = new Map(columns.map((c) => [c.name, c.writable]));
    expect(writable.get("created_at")).toBe(false);
    expect(writable.get("updated_at")).toBe(false);
    expect(writable.get("name")).toBe(true);
  });

  test("browses and filters the real users table", async () => {
    const cookie = await login();

    const { body } = await adminFetch("/tables/users/list", {
      method: "POST",
      cookie,
      body: { filter: { column: "email", op: "contains", value: "mario" } },
    });

    const rows = body.data as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(DEFAULT_TEST_USER.email);
    expect(rows[0].password_hash).toBeUndefined();
  });

  test("edits a real user row", async () => {
    const cookie = await login();
    const [user] = (
      await adminFetch("/tables/users/list", {
        method: "POST",
        cookie,
        body: {},
      })
    ).body.data as { id: number }[];

    const updated = await adminFetch("/tables/users/record", {
      method: "POST",
      cookie,
      body: { pk: { id: user.id }, values: { name: "Renamed By Admin" } },
    });

    expect(updated.status).toBe(200);
    expect(updated.body.record.name).toBe("Renamed By Admin");
  });

  test("reports the database's unique constraint on a colliding edit", async () => {
    const cookie = await login();
    await createTestUser(getUrl(), {
      name: "Luigi",
      email: "luigi@example.com",
    });

    const rows = (
      await adminFetch("/tables/users/list", {
        method: "POST",
        cookie,
        body: { sort: [{ column: "id", direction: "asc" }] },
      })
    ).body.data as { id: number; name: string }[];

    // `name` carries a unique index, so Luigi can't take Mario's name.
    const clash = await adminFetch("/tables/users/record", {
      method: "POST",
      cookie,
      body: { pk: { id: rows[1].id }, values: { name: rows[0].name } },
    });

    expect(clash.body.error.message).toContain("already exists");
    expect(clash.body.error.message).toContain("name_idx");
  });

  test("cannot insert into a table whose required column is hidden", async () => {
    const cookie = await login();

    // `password_hash` is NOT NULL with no default, and config hides it — so the
    // dashboard can browse and edit users but not create them. That's the intended
    // consequence of hiding a required column, not a bug to route around.
    const { body } = await adminFetch("/tables/users/record", {
      method: "PUT",
      cookie,
      body: { values: { name: "Peach", email: "peach@example.com" } },
    });

    expect(body.error.message).toContain("required value is missing");
  });

  test("keeps admin actions off the MCP surface by default", () => {
    expect(config.admin.mcp).toBe(false);
    const list = api.actions.actions.find((a) => a.name === "admin:table:list");
    expect(list?.mcp?.tool).toBe(false);
  });
});
