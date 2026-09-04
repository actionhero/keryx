import { integer, pgTable, serial } from "drizzle-orm/pg-core";

// The export name (`gadgets`) intentionally differs from the SQL name (`gadgets_table`)
// so tests can prove the registry keys off the export, not the table name.
export const gadgets = pgTable("gadgets_table", {
  id: serial("id").primaryKey(),
  widgetId: integer("widget_id").notNull(),
});
