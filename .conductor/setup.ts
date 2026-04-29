#!/usr/bin/env bun
/**
 * Conductor workspace setup script.
 * Reads .env.example files and overrides workspace-specific variables
 * (ports, Redis DBs, Postgres DBs) using CONDUCTOR_PORT for isolation
 * across parallel workspaces.
 *
 * Environment variables provided by Conductor:
 *   CONDUCTOR_WORKSPACE_NAME  - Workspace name
 *   CONDUCTOR_WORKSPACE_PATH  - Workspace directory path
 *   CONDUCTOR_ROOT_PATH       - Path to the repository root
 *   CONDUCTOR_PORT            - First in a range of 10 ports assigned to the workspace
 */

import { $ } from "bun";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");

const workspaceName = process.env.CONDUCTOR_WORKSPACE_NAME;
const conductorPort = process.env.CONDUCTOR_PORT
  ? parseInt(process.env.CONDUCTOR_PORT)
  : undefined;

let backendPort: number;
let frontendPort: number;
let redisDb: number;
let redisDbTest: number;
let dbName: string;
let dbNameTest: string;

if (!workspaceName || !conductorPort) {
  console.log(
    "CONDUCTOR_WORKSPACE_NAME or CONDUCTOR_PORT not set. Using defaults.",
  );
  backendPort = 8080;
  frontendPort = 3000;
  redisDb = 0;
  redisDbTest = 1;
  dbName = "keryx";
  dbNameTest = "keryx-test";
} else {
  console.log(`Workspace: ${workspaceName}`);

  // Use CONDUCTOR_PORT for backend, +1 for frontend
  backendPort = conductorPort;
  frontendPort = conductorPort + 1;

  // Derive Redis DB offset from workspace name hash
  const hash = Buffer.from(workspaceName).reduce((acc, byte) => acc + byte, 0);
  const offset = hash % 50;
  redisDb = (offset * 2) % 16;
  redisDbTest = (offset * 2 + 1) % 16;
  dbName = `keryx_${offset}`;
  dbNameTest = `keryx_${offset}_test`;
}

console.log(`Backend port:    ${backendPort}`);
console.log(`Frontend port:   ${frontendPort}`);
console.log(`Redis DB:        ${redisDb} (test: ${redisDbTest})`);
console.log(`Postgres DB:     ${dbName} (test: ${dbNameTest})`);

// Discover Postgres CLI tools (Homebrew keg-only installs aren't on PATH).
// Bun's $ shell doesn't re-read process.env.PATH, so we resolve full paths.
let pgBin = "";
const brewPgPrefix = await $`brew --prefix postgresql@17 2>/dev/null`
  .quiet()
  .nothrow();
if (brewPgPrefix.exitCode === 0) {
  const candidate = join(brewPgPrefix.stdout.toString().trim(), "bin");
  if (existsSync(candidate)) {
    pgBin = candidate + "/";
    console.log(`Using Postgres tools from ${candidate}`);
  }
}

const pgIsReady = `${pgBin}pg_isready`;
const psql = `${pgBin}psql`;
const createdb = `${pgBin}createdb`;

// Ensure Postgres is running
try {
  await $`${{ raw: pgIsReady }} -q`.quiet();
  console.log("Postgres is running.");
} catch {
  console.log("Postgres is not running. Starting via Homebrew...");
  await $`brew services start postgresql@17`.quiet().nothrow();
  for (let i = 0; i < 10; i++) {
    try {
      await $`${{ raw: pgIsReady }} -q`.quiet();
      break;
    } catch {
      await Bun.sleep(500);
    }
  }
  console.log("Postgres started.");
}

// Create Postgres databases if they don't exist
for (const db of [dbName, dbNameTest]) {
  const result =
    await $`${{ raw: psql }} -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw ${db}`.nothrow();
  if (result.exitCode === 0) {
    console.log(`Database '${db}' already exists.`);
  } else {
    console.log(`Creating database '${db}'...`);
    const createResult = await $`${{ raw: createdb }} ${db}`.nothrow();
    if (createResult.exitCode !== 0) {
      console.log(
        `WARNING: Could not create database '${db}'. Create it manually: createdb ${db}`,
      );
    }
  }
}

// Helper: apply overrides to a .env.example and write to .env
function applyEnvOverrides(
  exampleFile: string,
  outputFile: string,
  overrides: Record<string, string>,
) {
  if (!existsSync(exampleFile)) {
    console.log(`WARNING: ${exampleFile} not found, skipping.`);
    return;
  }

  let content = require("fs").readFileSync(exampleFile, "utf-8") as string;

  for (const [key, val] of Object.entries(overrides)) {
    const regex = new RegExp(`^#?\\s*${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }

  require("fs").writeFileSync(outputFile, content);
}

const applicationUrl = `"http://localhost:${backendPort}"`;
const allowedOrigins = `"http://localhost:${frontendPort},http://localhost:3000"`;
const databaseUrl = `"postgres://${process.env.USER}@localhost:5432/${dbName}"`;
const databaseUrlTest = `"postgres://${process.env.USER}@localhost:5432/${dbNameTest}"`;
const redisUrl = `"redis://localhost:6379/${redisDb}"`;
const redisUrlTest = `"redis://localhost:6379/${redisDbTest}"`;

const envOverrides = {
  WEB_SERVER_PORT: String(backendPort),
  APPLICATION_URL: applicationUrl,
  WEB_SERVER_ALLOWED_ORIGINS: allowedOrigins,
  DATABASE_URL: databaseUrl,
  DATABASE_URL_TEST: databaseUrlTest,
  REDIS_URL: redisUrl,
  REDIS_URL_TEST: redisUrlTest,
};

// Write .env for every package that ships a .env.example (framework + plugins).
// Recurses one level so packages/plugins/<name>/ is also covered.
function writePackageEnv(pkgDir: string, label: string): void {
  const examplePath = join(pkgDir, ".env.example");
  if (!existsSync(examplePath)) return;
  applyEnvOverrides(examplePath, join(pkgDir, ".env"), envOverrides);
  console.log(`Wrote ${label}/.env`);
  for (const [key, val] of Object.entries(envOverrides)) {
    console.log(`  ${key}=${val}`);
  }
}

const packagesDir = join(ROOT_DIR, "packages");
for (const pkg of readdirSync(packagesDir)) {
  const pkgDir = join(packagesDir, pkg);
  writePackageEnv(pkgDir, `packages/${pkg}`);
  // Plugins are nested under packages/plugins/<name>; also process them.
  if (pkg === "plugins") {
    for (const plugin of readdirSync(pkgDir)) {
      writePackageEnv(join(pkgDir, plugin), `packages/plugins/${plugin}`);
    }
  }
}

// Write example/backend/.env
applyEnvOverrides(
  join(ROOT_DIR, "example/backend/.env.example"),
  join(ROOT_DIR, "example/backend/.env"),
  envOverrides,
);
console.log("Wrote example/backend/.env");
for (const [key, val] of Object.entries(envOverrides)) {
  console.log(`  ${key}=${val}`);
}

// Write example/frontend/.env
const frontendOverrides = {
  VITE_API_URL: `http://localhost:${backendPort}`,
  PORT: String(frontendPort),
};
applyEnvOverrides(
  join(ROOT_DIR, "example/frontend/.env.example"),
  join(ROOT_DIR, "example/frontend/.env"),
  frontendOverrides,
);
console.log("Wrote example/frontend/.env");
for (const [key, val] of Object.entries(frontendOverrides)) {
  console.log(`  ${key}=${val}`);
}

console.log("\nSetup complete! Run 'bun dev' to start both servers.");
