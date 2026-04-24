#! /usr/bin/env bun

// Dev-mode overrides — the .env file is tuned for tests (port 0, silent logs).
// These must be set before keryx/config is imported, so we use dynamic import().
process.env.WEB_SERVER_PORT = "8080";
process.env.LOG_LEVEL = "info";
process.env.PROCESS_NAME = "resque-admin-dev";
process.env.TASK_PROCESSORS = "1";
process.env.RESQUE_ADMIN_SEED_DEMO ??= "1";

const { buildProgram, config } = await import("keryx");
const { resqueAdminPlugin } = await import("./index");
const { demoPlugin } = await import("./demo/plugin");
const pkg = (await import("./package.json")).default;

// Register this plugin for dev mode
config.plugins.push(resqueAdminPlugin);
config.plugins.push(demoPlugin);
config.resqueAdmin = {
  password: process.env.RESQUE_ADMIN_PASSWORD || "admin",
};

if (!process.env.RESQUE_ADMIN_PASSWORD) {
  console.warn(
    "⚠️  RESQUE_ADMIN_PASSWORD not set — using default password 'admin'. Set RESQUE_ADMIN_PASSWORD in your environment for anything other than local dev.",
  );
}

const program = await buildProgram({
  name: pkg.name,
  description: pkg.description ?? "",
  version: pkg.version,
});

program.parse();

export {};
