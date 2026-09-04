import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { api } from "keryx";

/**
 * A table exercising the metadata the dashboard renders from: a serial primary key, a
 * unique index, a NOT NULL column, a nullable column, a length-limited varchar, an enum,
 * a boolean, and a defaulted timestamp.
 */
export const adminWidgets = pgTable(
  "admin_widgets",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    label: varchar("label", { length: 8 }),
    quantity: integer("quantity").notNull().default(0),
    status: text("status", { enum: ["draft", "live", "retired"] }),
    // Nullable *and* defaulted, so "omitted" and "explicitly null" are distinguishable.
    tag: text("tag").default("untagged"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Writable, unlike created_at, so timestamp round-tripping is testable.
    scheduledAt: timestamp("scheduled_at"),
    // Both Drizzle spellings of a date-only column. They differ in the TS type handed
    // back (string vs Date) but share `sqlType: "date"`, and neither has a time
    // component — so both must avoid the timezone shifting a timestamp needs.
    dueOn: date("due_on"),
    startOn: date("start_on", { mode: "date" }),
  },
  (table) => ({
    nameIndex: uniqueIndex("admin_widgets_name_idx").on(table.name),
  }),
);

/** Carries a foreign key, so FK metadata and FK violations are both reachable. */
export const adminGadgets = pgTable("admin_gadgets", {
  id: serial("id").primaryKey(),
  widgetId: integer("widget_id")
    .references(() => adminWidgets.id)
    .notNull(),
  note: text("note"),
});

/** Composite primary key, to prove rows can be addressed by more than one column. */
export const adminMemberships = pgTable(
  "admin_memberships",
  {
    widgetId: integer("widget_id").notNull(),
    tag: text("tag").notNull(),
    weight: integer("weight").notNull().default(1),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.widgetId, table.tag] }),
  }),
);

/** No primary key, so individual rows cannot be addressed for writes. */
export const adminKeyless = pgTable("admin_keyless", {
  value: text("value").notNull(),
});

export const fixtureSchema = {
  adminWidgets,
  adminGadgets,
  adminMemberships,
  adminKeyless,
};

/**
 * Create the fixture tables and register them on `api.db.schema`.
 *
 * Plugin tests boot with `api.rootDir` pointing at the framework package, which has no
 * `schema/` directory, so the registry starts empty. Assigning to it directly is the
 * same move the CSRF plugin's tests make with `api.actions.actions` — it exercises the
 * real code path without needing a whole example app.
 */
export async function createFixtureTables() {
  await api.db.db.execute(
    sql.raw(`
    CREATE TABLE IF NOT EXISTS "admin_widgets" (
      "id" serial PRIMARY KEY,
      "name" text NOT NULL,
      "label" varchar(8),
      "quantity" integer NOT NULL DEFAULT 0,
      "status" text,
      "tag" text DEFAULT 'untagged',
      "active" boolean NOT NULL DEFAULT true,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "scheduled_at" timestamp,
      "due_on" date,
      "start_on" date
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "admin_widgets_name_idx" ON "admin_widgets" ("name");

    CREATE TABLE IF NOT EXISTS "admin_gadgets" (
      "id" serial PRIMARY KEY,
      "widget_id" integer NOT NULL REFERENCES "admin_widgets"("id"),
      "note" text
    );

    CREATE TABLE IF NOT EXISTS "admin_memberships" (
      "widget_id" integer NOT NULL,
      "tag" text NOT NULL,
      "weight" integer NOT NULL DEFAULT 1,
      PRIMARY KEY ("widget_id", "tag")
    );

    CREATE TABLE IF NOT EXISTS "admin_keyless" ("value" text NOT NULL);
  `),
  );

  Object.assign(api.db.schema, fixtureSchema);
}

/** Drop the fixture tables and unregister them. */
export async function dropFixtureTables() {
  await api.db.db.execute(
    sql.raw(`
    DROP TABLE IF EXISTS "admin_gadgets";
    DROP TABLE IF EXISTS "admin_memberships";
    DROP TABLE IF EXISTS "admin_keyless";
    DROP TABLE IF EXISTS "admin_widgets";
  `),
  );

  for (const key of Object.keys(fixtureSchema)) delete api.db.schema[key];
}

/** Reset fixture rows between tests without dropping the tables. */
export async function truncateFixtures() {
  await api.db.db.execute(
    sql.raw(
      `TRUNCATE TABLE "admin_gadgets", "admin_memberships", "admin_keyless", "admin_widgets" RESTART IDENTITY CASCADE`,
    ),
  );
}
