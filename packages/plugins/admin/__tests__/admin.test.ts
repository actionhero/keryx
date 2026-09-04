import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { api, config } from "keryx";
import { createAdminListAction } from "../actions/list";
import {
  createAdminCreateAction,
  createAdminDestroyAction,
  createAdminShowAction,
  createAdminUpdateAction,
} from "../actions/records";
import {
  createAdminTableSchemaAction,
  createAdminTablesAction,
} from "../actions/tables";
import { createAdminUIAction } from "../actions/ui";
import { adminPlugin } from "../index";
import type { AdminColumnMeta, AdminTableMeta } from "../util/introspect";
import { type AdminRole, roleFromUserColumn } from "../util/roles";
import {
  adminWidgets,
  createFixtureTables,
  dropFixtureTables,
  truncateFixtures,
} from "./fixtures/schema";
import { HOOK_TIMEOUT, serverUrl } from "./setup";

/**
 * The role the plugin's resolver reports. Tests reassign this to walk through
 * `full`, `read-only`, and denied without restarting the server — which is exactly the
 * flexibility a callback-based resolver buys over declarative config.
 */
let currentRole: AdminRole | null = "full";

const ADMIN = () => `${serverUrl()}/api/admin`;

type ErrorBody = { error: { message: string; type: string } };

async function request(
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const res = await fetch(`${ADMIN()}${path}`, {
    method: init.method ?? "GET",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as unknown) : null,
    res,
  };
}

/** Request that must succeed; returns the parsed body. */
async function ok<T>(path: string, init?: { method?: string; body?: unknown }) {
  const { status, body } = await request(path, init);
  if (status !== 200) {
    throw new Error(
      `${path} failed with ${status}: ${JSON.stringify(body, null, 2)}`,
    );
  }
  return body as T;
}

const errorOf = (body: unknown) => (body as ErrorBody).error;

async function createWidget(values: Record<string, unknown>) {
  return ok<{ record: Record<string, unknown> }>(
    "/tables/admin_widgets/record",
    { method: "PUT", body: { values } },
  );
}

async function listWidgets(body: Record<string, unknown> = {}) {
  return ok<{
    data: Record<string, unknown>[];
    pagination: { page: number; limit: number; total: number; pages: number };
  }>("/tables/admin_widgets/list", { method: "POST", body });
}

const names = (rows: Record<string, unknown>[]) => rows.map((r) => r.name);

describe("admin plugin", () => {
  beforeAll(async () => {
    config.plugins.push(
      adminPlugin({
        resolveRole: () => currentRole,
        columns: {
          admin_widgets: { readOnly: ["created_at"] },
          admin_gadgets: { hidden: ["note"] },
        },
        tables: { exclude: ["admin_excluded"] },
      }),
    );

    await api.start();
    await createFixtureTables();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await dropFixtureTables();
    await api.stop();
  }, HOOK_TIMEOUT);

  beforeEach(async () => {
    currentRole = "full";
    await truncateFixtures();
  });

  describe("authorization", () => {
    test("denies every data action when the resolver returns null", async () => {
      currentRole = null;

      const attempts = [
        await request("/tables"),
        await request("/tables/admin_widgets/schema"),
        await request("/tables/admin_widgets/list", {
          method: "POST",
          body: {},
        }),
        await request("/tables/admin_widgets/record", {
          method: "PUT",
          body: { values: { name: "nope" } },
        }),
      ];

      for (const attempt of attempts) expect(attempt.status).toBe(401);
    });

    test("read-only callers can browse", async () => {
      await createWidget({ name: "readable" });
      currentRole = "read-only";

      const list = await listWidgets();
      expect(names(list.data)).toEqual(["readable"]);
      expect((await ok<{ role: string }>("/tables")).role).toBe("read-only");
    });

    test("read-only callers are refused on create, update, and delete", async () => {
      const { record } = await createWidget({ name: "locked" });
      currentRole = "read-only";

      const create = await request("/tables/admin_widgets/record", {
        method: "PUT",
        body: { values: { name: "nope" } },
      });
      const update = await request("/tables/admin_widgets/record", {
        method: "POST",
        body: { pk: { id: record.id }, values: { name: "changed" } },
      });
      const destroy = await request("/tables/admin_widgets/record", {
        method: "DELETE",
        body: { pk: { id: record.id } },
      });

      for (const attempt of [create, update, destroy]) {
        expect(attempt.status).toBe(403);
        expect(errorOf(attempt.body).message).toContain("read-only");
      }

      // The refusal is real, not cosmetic.
      currentRole = "full";
      expect(names((await listWidgets()).data)).toEqual(["locked"]);
    });

    test("responds 404 for every action when the dashboard is disabled", async () => {
      config.admin.enabled = false;
      try {
        expect((await request("/tables")).status).toBe(404);
        expect(
          (
            await request("/tables/admin_widgets/list", {
              method: "POST",
              body: {},
            })
          ).status,
        ).toBe(404);

        // The UI has no role middleware, so it has to check `enabled` itself —
        // otherwise turning the dashboard off leaves the route advertising itself.
        const ui = await fetch(`${serverUrl()}/api/admin`);
        expect(ui.status).toBe(404);
      } finally {
        config.admin.enabled = true;
      }
    });
  });

  describe("roleFromUserColumn", () => {
    type FakeSession = { userId?: number };

    /** Stand in for a Connection carrying just the session the helper reads. */
    const connectionFor = (session: FakeSession | undefined) =>
      ({ session: session ? { data: session } : undefined }) as never;

    const resolver = roleFromUserColumn<FakeSession>({
      table: adminWidgets,
      sessionKey: (session) => session.userId,
      // `name` stands in for whatever column an app keys admin access off.
      role: (row) =>
        row.name === "admin-full"
          ? "full"
          : row.name === "admin-read"
            ? "read-only"
            : null,
    });

    test("maps a loaded row to a role", async () => {
      const full = await createWidget({ name: "admin-full" });
      const read = await createWidget({ name: "admin-read" });

      expect(
        await resolver(connectionFor({ userId: full.record.id as number })),
      ).toBe("full");
      expect(
        await resolver(connectionFor({ userId: read.record.id as number })),
      ).toBe("read-only");
    });

    test("denies when the mapping returns null", async () => {
      const { record } = await createWidget({ name: "ordinary" });

      expect(
        await resolver(connectionFor({ userId: record.id as number })),
      ).toBeNull();
    });

    test("denies anonymous callers and rows that no longer exist", async () => {
      expect(await resolver(connectionFor(undefined))).toBeNull();
      expect(await resolver(connectionFor({}))).toBeNull();
      expect(await resolver(connectionFor({ userId: 999999 }))).toBeNull();
    });
  });

  describe("table discovery", () => {
    test("lists the tables registered on api.db.schema with row counts", async () => {
      await createWidget({ name: "counted" });

      const { tables } = await ok<{
        tables: { name: string; rows: number; writable: boolean }[];
      }>("/tables");

      const byName = new Map(tables.map((t) => [t.name, t]));
      expect([...byName.keys()]).toEqual([
        "admin_gadgets",
        "admin_keyless",
        "admin_memberships",
        "admin_widgets",
      ]);
      expect(byName.get("admin_widgets")?.rows).toBe(1);
      // No primary key means no way to address a row.
      expect(byName.get("admin_keyless")?.writable).toBe(false);
      expect(byName.get("admin_widgets")?.writable).toBe(true);
    });

    test("refuses tables that are not in the registry", async () => {
      const { status, body } = await request("/tables/pg_tables/schema");

      expect(status).toBe(500);
      expect(errorOf(body).message).toContain("Unknown table");
    });
  });

  describe("schema introspection", () => {
    let meta: AdminTableMeta;
    const column = (name: string) =>
      meta.columns.find((c) => c.name === name) as AdminColumnMeta;

    beforeAll(async () => {
      meta = await ok<AdminTableMeta>("/tables/admin_widgets/schema");
    });

    test("reports SQL types and nullability", () => {
      expect(column("name").sqlType).toBe("text");
      expect(column("name").nullable).toBe(false);
      expect(column("label").sqlType).toBe("varchar(8)");
      expect(column("label").nullable).toBe(true);
    });

    test("reports the primary key and its column flag", () => {
      expect(meta.primaryKey).toEqual(["id"]);
      expect(column("id").primaryKey).toBe(true);
    });

    test("reports uniqueness declared as a unique index", () => {
      expect(column("name").unique).toBe(true);
      expect(column("quantity").unique).toBe(false);
    });

    test("reports defaults and enum values", () => {
      expect(column("quantity").hasDefault).toBe(true);
      expect(column("created_at").hasDefault).toBe(true);
      expect(column("status").enumValues).toEqual(["draft", "live", "retired"]);
      expect(column("name").enumValues).toBeNull();
    });

    test("marks config-declared readOnly columns unwritable but still readable", () => {
      expect(column("created_at").writable).toBe(false);
      expect(column("name").writable).toBe(true);
    });

    test("omits hidden columns entirely", async () => {
      const gadgets = await ok<AdminTableMeta>("/tables/admin_gadgets/schema");

      expect(gadgets.columns.map((c) => c.name)).toEqual(["id", "widget_id"]);
    });

    test("reports foreign key targets", async () => {
      const gadgets = await ok<AdminTableMeta>("/tables/admin_gadgets/schema");
      const fk = gadgets.columns.find((c) => c.name === "widget_id");

      expect(fk?.references).toEqual({ table: "admin_widgets", column: "id" });
    });

    test("reports composite primary keys", async () => {
      const memberships = await ok<AdminTableMeta>(
        "/tables/admin_memberships/schema",
      );

      expect(memberships.primaryKey).toEqual(["widget_id", "tag"]);
      expect(memberships.writable).toBe(true);
    });
  });

  describe("browsing", () => {
    beforeEach(async () => {
      for (const [index, name] of [
        "alpha",
        "beta",
        "gamma",
        "delta",
      ].entries()) {
        await createWidget({
          name,
          quantity: index * 10,
          label: name.slice(0, 3),
        });
      }
    });

    test("paginates with a stable primary key order by default", async () => {
      const first = await listWidgets({ limit: 2, page: 1 });
      const second = await listWidgets({ limit: 2, page: 2 });

      expect(names(first.data)).toEqual(["alpha", "beta"]);
      expect(names(second.data)).toEqual(["gamma", "delta"]);
      expect(first.pagination).toEqual({
        page: 1,
        limit: 2,
        total: 4,
        pages: 2,
      });
    });

    test("sorts by a requested column and direction", async () => {
      const ascending = await listWidgets({
        sort: [{ column: "name", direction: "asc" }],
      });
      const descending = await listWidgets({
        sort: [{ column: "name", direction: "desc" }],
      });

      expect(names(ascending.data)).toEqual([
        "alpha",
        "beta",
        "delta",
        "gamma",
      ]);
      expect(names(descending.data)).toEqual([
        "gamma",
        "delta",
        "beta",
        "alpha",
      ]);
    });

    test("filters on a single condition", async () => {
      const list = await listWidgets({
        filter: { column: "name", op: "eq", value: "beta" },
      });

      expect(names(list.data)).toEqual(["beta"]);
      expect(list.pagination.total).toBe(1);
    });

    test("combines conditions with and", async () => {
      const list = await listWidgets({
        filter: {
          and: [
            { column: "quantity", op: "gte", value: 10 },
            { column: "quantity", op: "lt", value: 30 },
          ],
        },
      });

      expect(names(list.data)).toEqual(["beta", "gamma"]);
    });

    test("combines conditions with or", async () => {
      const list = await listWidgets({
        filter: {
          or: [
            { column: "name", op: "eq", value: "alpha" },
            { column: "name", op: "eq", value: "delta" },
          ],
        },
      });

      expect(names(list.data)).toEqual(["alpha", "delta"]);
    });

    test("nests and inside or", async () => {
      const list = await listWidgets({
        filter: {
          or: [
            {
              and: [
                { column: "name", op: "startsWith", value: "a" },
                { column: "quantity", op: "eq", value: 0 },
              ],
            },
            { column: "quantity", op: "eq", value: 30 },
          ],
        },
      });

      expect(names(list.data).sort()).toEqual(["alpha", "delta"]);
    });

    test("negates a condition with not", async () => {
      const list = await listWidgets({
        filter: { not: { column: "name", op: "eq", value: "alpha" } },
      });

      expect(names(list.data)).toEqual(["beta", "gamma", "delta"]);
    });

    test("supports in, between, and null checks", async () => {
      await createWidget({ name: "nullable-label" });

      const inList = await listWidgets({
        filter: { column: "name", op: "in", value: ["alpha", "gamma"] },
      });
      const ranged = await listWidgets({
        filter: { column: "quantity", op: "between", value: [10, 20] },
      });
      const nulls = await listWidgets({
        filter: { column: "label", op: "isNull" },
      });

      expect(names(inList.data).sort()).toEqual(["alpha", "gamma"]);
      expect(names(ranged.data)).toEqual(["beta", "gamma"]);
      expect(names(nulls.data)).toEqual(["nullable-label"]);
    });

    test("treats contains as a literal substring search, not a wildcard", async () => {
      await createWidget({ name: "100% cotton" });

      const literal = await listWidgets({
        filter: { column: "name", op: "contains", value: "100%" },
      });
      // If the % leaked into the pattern unescaped this would match everything.
      const wildcardAttempt = await listWidgets({
        filter: { column: "name", op: "contains", value: "%" },
      });

      expect(names(literal.data)).toEqual(["100% cotton"]);
      expect(names(wildcardAttempt.data)).toEqual(["100% cotton"]);
    });

    test("still honors like when the caller wants real wildcards", async () => {
      const list = await listWidgets({
        filter: { column: "name", op: "like", value: "%elt%" },
      });

      expect(names(list.data)).toEqual(["delta"]);
    });

    test("rejects filters and sorts on unknown columns", async () => {
      const badFilter = await request("/tables/admin_widgets/list", {
        method: "POST",
        body: { filter: { column: "nope", op: "eq", value: 1 } },
      });
      const badSort = await request("/tables/admin_widgets/list", {
        method: "POST",
        body: { sort: [{ column: "nope", direction: "asc" }] },
      });

      expect(errorOf(badFilter.body).message).toContain(
        'Unknown column "nope"',
      );
      expect(errorOf(badSort.body).message).toContain('Unknown column "nope"');
    });

    test("rejects filters targeting a hidden column", async () => {
      const { body } = await request("/tables/admin_gadgets/list", {
        method: "POST",
        body: { filter: { column: "note", op: "eq", value: "x" } },
      });

      expect(errorOf(body).message).toContain('Unknown column "note"');
    });

    test("rejects a page size above the configured ceiling", async () => {
      const { status } = await request("/tables/admin_widgets/list", {
        method: "POST",
        body: { limit: config.admin.maxLimit + 1 },
      });

      expect(status).toBe(406);
    });

    test("omits hidden columns from returned rows", async () => {
      const widget = (await listWidgets()).data[0];
      await ok("/tables/admin_gadgets/record", {
        method: "PUT",
        body: { values: { widget_id: widget.id } },
      });

      const gadgets = await ok<{ data: Record<string, unknown>[] }>(
        "/tables/admin_gadgets/list",
        { method: "POST", body: {} },
      );

      // `note` exists in the table but is hidden by config, so it never reaches a client.
      expect(Object.keys(gadgets.data[0]).sort()).toEqual(["id", "widget_id"]);
    });
  });

  describe("reading one record", () => {
    test("fetches a row by primary key", async () => {
      const { record } = await createWidget({ name: "findable" });

      const found = await ok<{ record: Record<string, unknown> }>(
        "/tables/admin_widgets/show",
        { method: "POST", body: { pk: { id: record.id } } },
      );

      expect(found.record.name).toBe("findable");
    });

    test("returns 404 for a primary key that matches nothing", async () => {
      const { status, body } = await request("/tables/admin_widgets/show", {
        method: "POST",
        body: { pk: { id: 999999 } },
      });

      expect(status).toBe(404);
      expect(errorOf(body).message).toContain("No row");
    });

    test("refuses to address rows in a table with no primary key", async () => {
      const { body } = await request("/tables/admin_keyless/show", {
        method: "POST",
        body: { pk: { value: "x" } },
      });

      expect(errorOf(body).message).toContain("no primary key");
    });
  });

  describe("writing", () => {
    test("creates a row and applies database defaults for omitted columns", async () => {
      const { record } = await createWidget({ name: "fresh" });

      expect(record.id).toBeDefined();
      expect(record.quantity).toBe(0);
      expect(record.active).toBe(true);
      expect(record.created_at).toBeDefined();
    });

    test("updates only the supplied columns", async () => {
      const { record } = await createWidget({ name: "before", quantity: 5 });

      const updated = await ok<{ record: Record<string, unknown> }>(
        "/tables/admin_widgets/record",
        {
          method: "POST",
          body: { pk: { id: record.id }, values: { name: "after" } },
        },
      );

      expect(updated.record.name).toBe("after");
      expect(updated.record.quantity).toBe(5);
    });

    test("deletes a row and reports it gone", async () => {
      const { record } = await createWidget({ name: "doomed" });

      const deleted = await ok<{ record: Record<string, unknown> }>(
        "/tables/admin_widgets/record",
        { method: "DELETE", body: { pk: { id: record.id } } },
      );

      expect(deleted.record.name).toBe("doomed");
      expect((await listWidgets()).pagination.total).toBe(0);
    });

    test("coerces strings from form-style clients", async () => {
      const { record } = await createWidget({
        name: "coerced",
        quantity: "42",
        active: "false",
        created_at: undefined,
      });

      expect(record.quantity).toBe(42);
      expect(record.active).toBe(false);
    });

    test("writes null when a nullable column is set to null", async () => {
      const { record } = await createWidget({ name: "nulled", label: "abc" });

      const updated = await ok<{ record: Record<string, unknown> }>(
        "/tables/admin_widgets/record",
        {
          method: "POST",
          body: { pk: { id: record.id }, values: { label: null } },
        },
      );

      expect(updated.record.label).toBeNull();
    });

    test("round-trips a timestamp without shifting it", async () => {
      const instant = "2026-03-04T05:06:07.000Z";
      const { record } = await createWidget({
        name: "scheduled",
        scheduled_at: instant,
      });

      expect(new Date(record.scheduled_at as string).toISOString()).toBe(
        instant,
      );
    });

    test("leaves untouched columns alone when updating one field", async () => {
      const instant = "2026-03-04T05:06:07.000Z";
      const { record } = await createWidget({
        name: "keeps-timestamp",
        scheduled_at: instant,
      });

      const updated = await ok<{ record: Record<string, unknown> }>(
        "/tables/admin_widgets/record",
        {
          method: "POST",
          body: { pk: { id: record.id }, values: { quantity: 7 } },
        },
      );

      expect(updated.record.quantity).toBe(7);
      // A partial update must not rewrite the timestamp; the dashboard's edit form
      // sends only changed fields for exactly this reason.
      expect(
        new Date(updated.record.scheduled_at as string).toISOString(),
      ).toBe(instant);
    });

    test("addresses rows by composite primary key", async () => {
      const { record } = await createWidget({ name: "host" });
      const pk = { widget_id: record.id, tag: "blue" };

      await ok("/tables/admin_memberships/record", {
        method: "PUT",
        body: { values: { ...pk, weight: 3 } },
      });

      const updated = await ok<{ record: Record<string, unknown> }>(
        "/tables/admin_memberships/record",
        { method: "POST", body: { pk, values: { weight: 9 } } },
      );

      expect(updated.record.weight).toBe(9);
    });

    test("requires every column of a composite primary key", async () => {
      const { body } = await request("/tables/admin_memberships/record", {
        method: "POST",
        body: { pk: { widget_id: 1 }, values: { weight: 2 } },
      });

      expect(errorOf(body).message).toContain(
        'Missing primary key value "tag"',
      );
    });

    test("rejects writes to readOnly and hidden columns", async () => {
      const readOnly = await request("/tables/admin_widgets/record", {
        method: "PUT",
        body: { values: { name: "x", created_at: "2020-01-01T00:00:00Z" } },
      });
      const hidden = await request("/tables/admin_gadgets/record", {
        method: "PUT",
        body: { values: { widget_id: 1, note: "nope" } },
      });

      expect(errorOf(readOnly.body).message).toContain("read-only");
      expect(errorOf(hidden.body).message).toContain('Unknown column "note"');
    });

    test("rejects writes to columns that do not exist", async () => {
      const { body } = await request("/tables/admin_widgets/record", {
        method: "PUT",
        body: { values: { name: "x", nonsense: 1 } },
      });

      expect(errorOf(body).message).toContain('Unknown column "nonsense"');
    });

    test("rejects a write with no usable columns", async () => {
      const { body } = await request("/tables/admin_widgets/record", {
        method: "PUT",
        body: { values: {} },
      });

      expect(errorOf(body).message).toContain("No writable columns");
    });
  });

  describe("the database validates writes", () => {
    test("surfaces a unique index violation with its constraint name", async () => {
      await createWidget({ name: "duplicate" });

      const { body } = await request("/tables/admin_widgets/record", {
        method: "PUT",
        body: { values: { name: "duplicate" } },
      });

      const { message } = errorOf(body);
      expect(message).toContain("already exists");
      expect(message).toContain("admin_widgets_name_idx");
    });

    test("surfaces a NOT NULL violation", async () => {
      const { body } = await request("/tables/admin_widgets/record", {
        method: "PUT",
        body: { values: { label: "abc" } },
      });

      expect(errorOf(body).message).toContain("required value is missing");
    });

    test("surfaces a foreign key violation", async () => {
      const { body } = await request("/tables/admin_gadgets/record", {
        method: "PUT",
        body: { values: { widget_id: 999999 } },
      });

      expect(errorOf(body).message).toContain("referenced row does not exist");
    });

    test("surfaces a value that is too long for its column", async () => {
      const { body } = await request("/tables/admin_widgets/record", {
        method: "PUT",
        body: {
          values: { name: "long", label: "way too long for varchar(8)" },
        },
      });

      expect(errorOf(body).message).toContain("too long");
    });

    test("surfaces an enum value the column rejects", async () => {
      // The fixture declares the enum in Drizzle only, so PostgreSQL accepts any text —
      // proving the plugin does not invent validation the database doesn't have.
      const { record } = await createWidget({ name: "enum", status: "live" });

      expect(record.status).toBe("live");
    });

    test("rejects a value that cannot be coerced to its column type", async () => {
      const { body } = await request("/tables/admin_widgets/record", {
        method: "PUT",
        body: { values: { name: "bad", quantity: "not-a-number" } },
      });

      expect(errorOf(body).message).toContain("expects a number");
    });

    test("never leaks SQL or bound parameters for an unmapped error", async () => {
      // 42P01 (undefined_table) has no mapping. Drizzle wraps driver failures in an
      // error whose message is the full SQL plus every parameter, and Keryx sends
      // `message` to the client — so the fallback must not pass it through.
      const secret = "s3cret-parameter-value";
      const { record } = await createWidget({ name: secret });
      await api.db.db.execute(
        sql.raw(`ALTER TABLE "admin_widgets" RENAME TO "admin_widgets_moved"`),
      );

      try {
        const { body } = await request("/tables/admin_widgets/show", {
          method: "POST",
          body: { pk: { id: record.id } },
        });

        const { message } = errorOf(body);
        expect(message).toContain("42P01");
        expect(message).not.toContain("select");
        expect(message).not.toContain("admin_widgets_moved");
        expect(message).not.toContain(secret);
      } finally {
        await api.db.db.execute(
          sql.raw(
            `ALTER TABLE "admin_widgets_moved" RENAME TO "admin_widgets"`,
          ),
        );
      }
    });
  });

  describe("the UI", () => {
    test("serves HTML with the configured routes substituted in", async () => {
      const res = await fetch(`${serverUrl()}/api/admin`);
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(html).toContain('const API = "/api/admin"');
      expect(html).not.toContain("{{API_ROUTE}}");
      expect(html).not.toContain("{{ADMIN_ROUTE}}");
    });

    test("serves the shell without a role, since it carries no data", async () => {
      currentRole = null;

      expect((await fetch(`${serverUrl()}/api/admin`)).status).toBe(200);
    });
  });

  describe("MCP exposure", () => {
    /** Every data action factory, to prove the toggle covers the whole group. */
    const dataFactories = [
      createAdminTablesAction,
      createAdminTableSchemaAction,
      createAdminListAction,
      createAdminShowAction,
      createAdminCreateAction,
      createAdminUpdateAction,
      createAdminDestroyAction,
    ];

    const build = (factory: (typeof dataFactories)[number]) =>
      new (factory({ resolveRole: () => "full", extraMiddleware: [] }))();

    test("keeps data actions off the MCP surface by default", () => {
      const dataAction = api.actions.actions.find(
        (a) => a.name === "admin:table:list",
      );

      expect(config.admin.mcp).toBe(false);
      expect(dataAction?.mcp?.tool).toBe(false);
    });

    test("config.admin.mcp switches the whole group on at once", () => {
      config.admin.mcp = true;
      try {
        // Read at construction, which the actions initializer runs after plugin
        // config defaults are merged.
        const enabled = dataFactories.map((f) => build(f).mcp?.tool);
        expect(enabled).toEqual(dataFactories.map(() => true));
      } finally {
        config.admin.mcp = false;
      }

      const disabled = dataFactories.map((f) => build(f).mcp?.tool);
      expect(disabled).toEqual(dataFactories.map(() => false));
    });

    test("never exposes the HTML UI action as a tool, even with MCP on", () => {
      const ui = api.actions.actions.find((a) => a.name === "admin:ui");
      expect(ui?.mcp?.tool).toBe(false);

      config.admin.mcp = true;
      try {
        const rebuilt = new (createAdminUIAction({
          resolveRole: () => "full",
          extraMiddleware: [],
        }))();
        expect(rebuilt.mcp.tool).toBe(false);
      } finally {
        config.admin.mcp = false;
      }
    });

    test("registers every data action under the admin route", () => {
      const routes = api.actions.actions
        .filter((a) => a.name.startsWith("admin:"))
        .map((a) => a.web?.route);

      expect(routes).toContain("/admin");
      expect(routes).toContain("/admin/tables");
      expect(routes).toContain("/admin/tables/:table/list");
      expect(routes).toContain("/admin/tables/:table/record");
    });
  });
});
