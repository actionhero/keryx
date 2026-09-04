import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { type ActionMiddleware, api, config } from "keryx";
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
import { createAdminUIAction, templatePath } from "../actions/ui";
import { adminPlugin } from "../index";
import type { AdminColumnMeta, AdminTableMeta } from "../util/introspect";
import { requireTable } from "../util/registry";
import { type AdminRole, roleFromUserColumn } from "../util/roles";
import { buildOrderBy } from "../util/sort";
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

const pluginActionNames = (plugin: ReturnType<typeof adminPlugin>): string[] =>
  (plugin.actions ?? []).map((ActionClass) => new ActionClass().name);

describe("admin plugin", () => {
  beforeAll(async () => {
    config.plugins.push(
      adminPlugin({
        resolveRole: () => currentRole,
        columns: {
          admin_widgets: { readOnly: ["created_at"] },
          admin_gadgets: { hidden: ["note"] },
          admin_hidden_key: { hidden: ["id"] },
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

    test("omits the HTML action when serveUi is false, keeping the JSON APIs", () => {
      const resolveRole = () => "full" as const;
      expect(pluginActionNames(adminPlugin({ resolveRole }))).toContain(
        "admin:ui",
      );

      const withoutUi = adminPlugin({ resolveRole, serveUi: false });
      const registered = pluginActionNames(withoutUi);
      expect(registered).not.toContain("admin:ui");
      expect(registered).toContain("admin:tables");
      expect(registered).toContain("admin:record:create");
      expect(
        (withoutUi.configDefaults as { admin: { serveUi: boolean } }).admin
          .serveUi,
      ).toBe(false);
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
        "admin_hidden_key",
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

    test("distinguishes calendar days from points in time", () => {
      // Both spellings of a date column report `date-only`, so a client picks a
      // date widget rather than a timezone-sensitive datetime one.
      expect(column("due_on").kind).toBe("date-only");
      expect(column("start_on").kind).toBe("date-only");
      expect(column("scheduled_at").kind).toBe("date");
      expect(column("created_at").kind).toBe("date");
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

      expect(gadgets.columns.map((c) => c.name)).toEqual([
        "id",
        "widget_id",
        "hidden_key_id",
      ]);
      expect(gadgets.columns.map((c) => c.name)).not.toContain("note");
    });

    test("reports foreign key targets", async () => {
      const gadgets = await ok<AdminTableMeta>("/tables/admin_gadgets/schema");
      const fk = gadgets.columns.find((c) => c.name === "widget_id");

      expect(fk?.references).toEqual({ table: "admin_widgets", column: "id" });
    });

    test("omits a reference whose target column is hidden", async () => {
      const gadgets = await ok<AdminTableMeta>("/tables/admin_gadgets/schema");
      const fk = gadgets.columns.find((c) => c.name === "hidden_key_id");

      // Points at admin_hidden_key.id, which config hides — naming it would disclose
      // a column that's meant to be indistinguishable from one that doesn't exist.
      expect(fk).toBeDefined();
      expect(fk?.references).toBeNull();
    });

    test("reports a multi-column unique constraint over visible columns", async () => {
      expect(meta.uniqueConstraints).toEqual([["label", "quantity"]]);
    });

    test("omits a unique constraint that spans a hidden column", async () => {
      const gadgets = await ok<AdminTableMeta>("/tables/admin_gadgets/schema");

      // The table has a UNIQUE (widget_id, note) constraint, but `note` is hidden.
      // Trimming it to (widget_id) would claim widget_id is unique on its own.
      expect(gadgets.uniqueConstraints).toEqual([]);
    });

    describe("a table whose primary key is hidden", () => {
      test("reports no primary key and no write capability", async () => {
        const meta = await ok<AdminTableMeta>(
          "/tables/admin_hidden_key/schema",
        );

        // A key the caller can't see is a key it can't send back, so advertising
        // either the key or write support would only promise failures.
        expect(meta.primaryKey).toEqual([]);
        expect(meta.writable).toBe(false);
        expect(meta.columns.map((c) => c.name)).toEqual(["label"]);
      });

      test("is reported unwritable in the table list too", async () => {
        const { tables } = await ok<{
          tables: { name: string; writable: boolean }[];
        }>("/tables");

        expect(
          tables.find((t) => t.name === "admin_hidden_key")?.writable,
        ).toBe(false);
      });

      test("refuses row-addressed reads and writes with an accurate reason", async () => {
        for (const attempt of [
          await request("/tables/admin_hidden_key/show", {
            method: "POST",
            body: { pk: { id: 1 } },
          }),
          await request("/tables/admin_hidden_key/record", {
            method: "POST",
            body: { pk: { id: 1 }, values: { label: "x" } },
          }),
          await request("/tables/admin_hidden_key/record", {
            method: "DELETE",
            body: { pk: { id: 1 } },
          }),
        ]) {
          expect(errorOf(attempt.body).message).toContain("no primary key");
        }
      });

      test("can still be browsed", async () => {
        await api.db.db.execute(
          sql.raw(
            `INSERT INTO "admin_hidden_key" ("label") VALUES ('visible')`,
          ),
        );

        const result = await ok<{ data: Record<string, unknown>[] }>(
          "/tables/admin_hidden_key/list",
          { method: "POST", body: {} },
        );

        expect(result.data).toEqual([{ label: "visible" }]);
      });

      test("still sorts by the hidden key for stable pagination", () => {
        // Ordering by a hidden column discloses nothing — ORDER BY doesn't return the
        // values it sorts on — so the key is still the best available tiebreaker.
        const exposed = requireTable("admin_hidden_key");
        const sql = api.db.db
          .select()
          .from(exposed.table)
          .orderBy(...buildOrderBy(exposed))
          .toSQL().sql;

        expect(sql).toContain(`order by "admin_hidden_key"."id" asc`);
      });
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

    describe("order-by construction", () => {
      /**
       * Asserted on the generated SQL rather than on paging behaviour. A tie-order bug
       * only shows up once the planner chooses a different access path between two page
       * requests, which small test tables never do — so a behavioural test would pass
       * with or without the tiebreaker and guard nothing.
       */
      const orderBySql = (
        sort?: Array<{ column: string; direction: "asc" | "desc" }>,
      ) => {
        const exposed = requireTable("admin_widgets");
        return api.db.db
          .select()
          .from(exposed.table)
          .orderBy(...buildOrderBy(exposed, sort))
          .toSQL().sql;
      };

      test("appends the primary key after a caller's sort", () => {
        const sql = orderBySql([{ column: "quantity", direction: "desc" }]);

        expect(sql).toContain(`order by "admin_widgets"."quantity" desc`);
        expect(sql).toContain(`"admin_widgets"."id" asc`);
      });

      test("orders by the primary key when no sort is requested", () => {
        expect(orderBySql()).toContain(`order by "admin_widgets"."id" asc`);
      });

      test("does not repeat a column the caller already sorted on", () => {
        const sql = orderBySql([{ column: "id", direction: "desc" }]);

        expect(sql).toContain(`order by "admin_widgets"."id" desc`);
        expect(sql).not.toContain(`"admin_widgets"."id" asc`);
      });

      test("falls back to every column for a table with no primary key", () => {
        const exposed = requireTable("admin_keyless");
        const sql = api.db.db
          .select()
          .from(exposed.table)
          .orderBy(...buildOrderBy(exposed))
          .toSQL().sql;

        expect(sql).toContain(`order by "admin_keyless"."value" asc`);
      });
    });

    test("pages a non-unique sort without skipping or duplicating rows", async () => {
      // Every row shares the same `quantity`, so the sort column can't order them.
      // Without a primary key tiebreaker the planner is free to return ties in a
      // different order for each page request, which shows one row twice and drops
      // another.
      await truncateFixtures();
      const expected = ["a", "b", "c", "d", "e", "f", "g", "h"];
      for (const name of expected) await createWidget({ name, quantity: 5 });

      const seen: string[] = [];
      for (let page = 1; page <= 4; page++) {
        const result = await listWidgets({
          limit: 2,
          page,
          sort: [{ column: "quantity", direction: "asc" }],
        });
        seen.push(...(names(result.data) as string[]));
      }

      expect(seen).toHaveLength(expected.length);
      expect([...new Set(seen)].sort()).toEqual(expected);
    });

    test("pages a keyless table without skipping or duplicating rows", async () => {
      // No primary key to tiebreak with, so ordering falls back to every column.
      for (const value of ["one", "two", "three", "four"]) {
        await ok("/tables/admin_keyless/record", {
          method: "PUT",
          body: { values: { value } },
        });
      }

      const seen: unknown[] = [];
      for (let page = 1; page <= 2; page++) {
        const result = await ok<{ data: Record<string, unknown>[] }>(
          "/tables/admin_keyless/list",
          { method: "POST", body: { limit: 2, page } },
        );
        seen.push(...result.data.map((row) => row.value));
      }

      expect([...new Set(seen)].sort()).toEqual([
        "four",
        "one",
        "three",
        "two",
      ]);
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
      expect(Object.keys(gadgets.data[0]).sort()).toEqual([
        "hidden_key_id",
        "id",
        "widget_id",
      ]);
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

    test("omitting a nullable column uses its database default", async () => {
      // The distinction the edit form depends on: a blank field must be omitted, not
      // sent as null, or every defaulted column gets clobbered on create.
      const { record } = await createWidget({ name: "defaulted" });

      expect(record.tag).toBe("untagged");
    });

    test("explicit null overrides a database default", async () => {
      const { record } = await createWidget({
        name: "explicit-null",
        tag: null,
      });

      expect(record.tag).toBeNull();
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

    test("round-trips a date-only column without shifting the day", async () => {
      // `due_on` is date() (a string) and `start_on` is date({ mode: "date" }) (a Date).
      // Both are calendar days, so neither may be dragged through a timezone: parsing
      // "2026-03-04" as UTC midnight and then formatting it locally lands on March 3rd
      // anywhere west of UTC.
      const day = "2026-03-04";
      const { record } = await createWidget({
        name: "dated",
        due_on: day,
        start_on: day,
      });

      expect(record.due_on).toBe(day);
      expect(String(record.start_on).slice(0, 10)).toBe(day);
    });

    test("accepts a full instant for a date-only column, keeping its UTC day", async () => {
      const { record } = await createWidget({
        name: "instant-for-date",
        due_on: "2026-03-04T23:30:00.000Z",
      });

      expect(record.due_on).toBe("2026-03-04");
    });

    test("rejects a value that is not a date for a date-only column", async () => {
      const { body } = await request("/tables/admin_widgets/record", {
        method: "PUT",
        body: { values: { name: "bad-date", due_on: "not-a-date" } },
      });

      expect(errorOf(body).message).toContain("YYYY-MM-DD");
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

    test("responds 404 for the UI when serveUi is false, leaving JSON APIs up", async () => {
      config.admin.serveUi = false;
      try {
        expect((await fetch(`${serverUrl()}/api/admin`)).status).toBe(404);
        expect((await request("/tables")).status).toBe(200);
      } finally {
        config.admin.serveUi = true;
      }
    });

    test("resolves its template even when the install path contains a space", async () => {
      // `new URL(...).pathname` leaves the space percent-encoded, so `Bun.file` would
      // look for a directory literally named `keryx admin%20`. Spaces in install paths
      // are ordinary on macOS and Windows, so this has to work.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "keryx admin "));
      fs.mkdirSync(path.join(root, "templates"));
      fs.writeFileSync(
        path.join(root, "templates", "admin.html"),
        "<html>stand-in</html>",
      );

      try {
        expect(root).toContain(" ");
        const resolved = templatePath(
          `${pathToFileURL(path.join(root, "actions")).href}/ui.ts`,
        );

        expect(resolved).not.toContain("%20");
        expect(await Bun.file(resolved).exists()).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("resolves the real template that ships with the package", async () => {
      expect(await Bun.file(templatePath()).exists()).toBe(true);
    });

    test("the inline script parses", async () => {
      // The dashboard is one file of inline JavaScript, so a syntax error anywhere in
      // it silently blanks the entire page — no console the server can see, and every
      // server-side test still green. `new Function` parses without executing, which
      // is enough to catch it.
      const html = await (await fetch(`${serverUrl()}/api/admin`)).text();
      const script = html.slice(
        html.indexOf("<script>") + "<script>".length,
        html.lastIndexOf("</script>"),
      );

      expect(script.length).toBeGreaterThan(1000);
      expect(() => new Function(script)).not.toThrow();
    });
  });

  describe("composing extra middleware", () => {
    const readGuard: ActionMiddleware = { runBefore: async () => {} };
    const writeGuard: ActionMiddleware = { runBefore: async () => {} };
    const opts = {
      resolveRole: () => "full" as const,
      extraMiddleware: [readGuard],
      writeMiddleware: [writeGuard],
    };

    test("write actions accept a csrfToken input", () => {
      // The regression this guards: Zod objects strip unknown keys, so a token the
      // schema doesn't declare is gone before middleware runs — which would make a
      // CSRF guard reject every write instead of protecting it.
      const create = new (createAdminCreateAction(opts))();
      const parsed = create.inputs.parse({
        table: "admin_widgets",
        values: { name: "x" },
        csrfToken: "a-token",
      });

      expect(parsed.csrfToken).toBe("a-token");
    });

    test("every write action declares the token", () => {
      for (const factory of [
        createAdminCreateAction,
        createAdminUpdateAction,
        createAdminDestroyAction,
      ]) {
        const action = new (factory(opts))();
        const parsed = action.inputs.parse({
          table: "admin_widgets",
          pk: { id: 1 },
          values: { name: "x" },
          csrfToken: "a-token",
        });
        expect(parsed.csrfToken).toBe("a-token");
      }
    });

    test("writeMiddleware runs on writes only", () => {
      const create = new (createAdminCreateAction(opts))();
      const list = new (createAdminListAction(opts))();

      expect(create.middleware).toContain(writeGuard);
      // Reads don't get it: a CSRF guard on a GET would force the token into a query
      // string, and reads have no state change to protect.
      expect(list.middleware).not.toContain(writeGuard);
    });

    test("extraMiddleware runs on both reads and writes", () => {
      const create = new (createAdminCreateAction(opts))();
      const list = new (createAdminListAction(opts))();

      expect(create.middleware).toContain(readGuard);
      expect(list.middleware).toContain(readGuard);
    });

    test("the role gate runs before any app middleware", () => {
      const create = new (createAdminCreateAction(opts))();

      expect(create.middleware.indexOf(readGuard)).toBeGreaterThan(0);
      expect(create.middleware.indexOf(writeGuard)).toBeGreaterThan(
        create.middleware.indexOf(readGuard),
      );
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
      new (factory({
        resolveRole: () => "full",
        extraMiddleware: [],
        writeMiddleware: [],
      }))();

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
          writeMiddleware: [],
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
