#! /usr/bin/env bun

// Dev-mode overrides — the .env file is tuned for tests (port 0, silent logs).
// These must be set before keryx/config is imported, so we use dynamic import().
process.env.WEB_SERVER_PORT = "8080";
process.env.LOG_LEVEL = "info";
process.env.PROCESS_NAME = "resque-admin-dev";
process.env.TASK_PROCESSORS = "1";

const { buildProgram } = await import("keryx");
const { config } = await import("keryx/config");
const { resqueAdminPlugin } = await import("./index");
const pkg = (await import("./package.json")).default;

// Register this plugin for dev mode
config.plugins.push(resqueAdminPlugin);
(config as unknown as { resqueAdmin: { password: string } }).resqueAdmin = {
  password: process.env.RESQUE_ADMIN_PASSWORD || "admin",
};

const program = await buildProgram({
  name: pkg.name,
  description: pkg.description ?? "",
  version: pkg.version,
});

program.parse();
