import type { KeryxPlugin } from "keryx";
import { SeedDemoTables } from "./initializers/seedDemo";

/**
 * Dev-only plugin that gives the admin dashboard a realistic schema to browse:
 * customers and orders, with a unique email index, enums, a foreign key, nullable
 * columns, and defaults.
 *
 * Intentionally not exported from the package entry point — it is wired into `dev.ts`
 * directly and excluded from the published npm package via the `files` allowlist in
 * package.json.
 */
export const demoPlugin: KeryxPlugin = {
  name: "admin-demo",
  version: "0.0.0",
  initializers: [SeedDemoTables],
};
