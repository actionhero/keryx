import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { api } from "keryx";

/**
 * Demo tables for `bun dev:admin`. Not published — the package's `files` allowlist
 * covers only the plugin itself. They exist so the dashboard has something realistic to
 * render: a unique email, an enum, a foreign key, nullable columns, and defaults.
 */
export const customers = pgTable(
  "demo_customers",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    email: text("email").notNull(),
    tier: text("tier", { enum: ["free", "pro", "enterprise"] })
      .notNull()
      .default("free"),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    emailIndex: uniqueIndex("demo_customers_email_idx").on(table.email),
  }),
);

export const orders = pgTable("demo_orders", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .references(() => customers.id)
    .notNull(),
  total: numeric("total", { precision: 10, scale: 2 }).notNull(),
  status: text("status", { enum: ["pending", "shipped", "refunded"] })
    .notNull()
    .default("pending"),
  placedAt: timestamp("placed_at").notNull().defaultNow(),
  // A calendar day with no time, so the form should offer a date picker and never
  // shift it through the browser's timezone.
  deliverOn: date("deliver_on"),
});

/** Create and register the demo tables, seeding a few rows on first run. */
export async function setupDemoTables() {
  await api.db.db.execute(
    sql.raw(`
    CREATE TABLE IF NOT EXISTS "demo_customers" (
      "id" serial PRIMARY KEY,
      "name" varchar(120) NOT NULL,
      "email" text NOT NULL,
      "tier" text NOT NULL DEFAULT 'free',
      "active" boolean NOT NULL DEFAULT true,
      "notes" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "demo_customers_email_idx" ON "demo_customers" ("email");

    CREATE TABLE IF NOT EXISTS "demo_orders" (
      "id" serial PRIMARY KEY,
      "customer_id" integer NOT NULL REFERENCES "demo_customers"("id"),
      "total" numeric(10,2) NOT NULL,
      "status" text NOT NULL DEFAULT 'pending',
      "placed_at" timestamp NOT NULL DEFAULT now(),
      "deliver_on" date
    );
  `),
  );

  Object.assign(api.db.schema, { customers, orders });

  const existing = await api.db.db.select().from(customers).limit(1);
  if (existing.length > 0) return;

  const seeded = await api.db.db
    .insert(customers)
    .values([
      { name: "Ada Lovelace", email: "ada@example.com", tier: "enterprise" },
      { name: "Grace Hopper", email: "grace@example.com", tier: "pro" },
      { name: "Alan Turing", email: "alan@example.com", active: false },
      {
        name: "Katherine Johnson",
        email: "katherine@example.com",
        tier: "pro",
      },
    ])
    .returning();

  await api.db.db.insert(orders).values(
    seeded.flatMap((customer, index) => [
      {
        customerId: customer.id,
        total: `${(index + 1) * 25}.00`,
        deliverOn: `2026-03-0${index + 1}`,
      },
      {
        customerId: customer.id,
        total: `${(index + 1) * 12}.50`,
        status: "shipped" as const,
      },
    ]),
  );
}
