import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const widgets = pgTable("widgets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

// Non-table exports live alongside tables in real schema files; the loader must skip them.
export const WIDGET_KINDS = ["round", "square"] as const;

export function widgetLabel(name: string) {
  return `widget:${name}`;
}
