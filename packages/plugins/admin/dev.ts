#! /usr/bin/env bun

// Dev-mode overrides — the .env file is tuned for tests (port 0, silent logs).
// These must be set before keryx/config is imported, so we use dynamic import().
process.env.WEB_SERVER_PORT = "8080";
process.env.LOG_LEVEL = "info";
process.env.PROCESS_NAME = "admin-dev";
process.env.TASK_PROCESSORS = "0";

const { buildProgram, config } = await import("keryx");
const { adminPlugin } = await import("./index");
const { demoPlugin } = await import("./demo/plugin");
const pkg = (await import("./package.json")).default;

/**
 * Dev-only role resolver. A real app resolves this from its own session — see
 * `roleFromUserColumn()` — but there's no session here, so the role comes from the
 * environment. Set `ADMIN_DEV_ROLE=read-only` to see the dashboard with write
 * controls hidden.
 */
const devRole =
  process.env.ADMIN_DEV_ROLE === "read-only" ? "read-only" : "full";

config.plugins.push(
  adminPlugin({
    resolveRole: () => devRole,
    columns: {
      // `placed_at` is left writable on purpose, so the demo exercises editing a
      // timestamp through the form.
      demo_customers: { readOnly: ["created_at"] },
    },
  }),
);
config.plugins.push(demoPlugin);

console.warn(
  `⚠️  Dev mode: every visitor gets the "${devRole}" admin role with no authentication. Never run this configuration anywhere real.`,
);

const program = await buildProgram({
  name: pkg.name,
  description: pkg.description ?? "",
  version: pkg.version,
});

program.parse();

export {};
