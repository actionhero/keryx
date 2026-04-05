#!/usr/bin/env bun
/**
 * Conductor workspace teardown script.
 * Drops Postgres databases and flushes Redis DBs created by setup.ts.
 *
 * Environment variables provided by Conductor:
 *   CONDUCTOR_WORKSPACE_NAME  - Workspace name
 *   CONDUCTOR_ROOT_PATH       - Path to the repository root
 */

import { $ } from "bun";

const workspaceName = process.env.CONDUCTOR_WORKSPACE_NAME;

if (!workspaceName) {
  console.log("CONDUCTOR_WORKSPACE_NAME is not set. Nothing to tear down.");
  process.exit(0);
}

const hash = Buffer.from(workspaceName).reduce((acc, byte) => acc + byte, 0);
const offset = hash % 50;
const dbName = `keryx_${offset}`;
const dbNameTest = `keryx_${offset}_test`;
const redisDb = (offset * 2) % 16;
const redisDbTest = (offset * 2 + 1) % 16;

console.log(`Workspace: ${workspaceName}`);
console.log(`Dropping databases: ${dbName}, ${dbNameTest}`);
console.log(`Flushing Redis DBs: ${redisDb}, ${redisDbTest}`);

// Drop Postgres databases
for (const db of [dbName, dbNameTest]) {
  const result = await $`dropdb --if-exists ${db}`.nothrow();
  if (result.exitCode === 0) {
    console.log(`Dropped database '${db}'.`);
  } else {
    console.log(`WARNING: Could not drop database '${db}'.`);
  }
}

// Flush Redis databases
for (const db of [redisDb, redisDbTest]) {
  const result = await $`redis-cli -n ${db} FLUSHDB`.nothrow();
  if (result.exitCode === 0) {
    console.log(`Flushed Redis DB ${db}.`);
  } else {
    console.log(`WARNING: Could not flush Redis DB ${db}.`);
  }
}

// Pull latest main in the parent repo (if it's on main)
const rootPath = process.env.CONDUCTOR_ROOT_PATH;
const defaultBranch = process.env.CONDUCTOR_DEFAULT_BRANCH ?? "main";
if (rootPath) {
  try {
    const currentBranch = (
      await $`git -C ${rootPath} branch --show-current`.text()
    ).trim();
    if (currentBranch === defaultBranch) {
      console.log(
        `Pulling latest ${defaultBranch} in parent repo (${rootPath})...`,
      );
      const result =
        await $`git -C ${rootPath} pull --ff-only origin ${defaultBranch}`.nothrow();
      if (result.exitCode === 0) {
        console.log(`Parent repo updated to latest ${defaultBranch}.`);
      } else {
        console.log(
          `WARNING: Could not pull latest ${defaultBranch} in parent repo.`,
        );
      }
    } else {
      console.log(
        `Parent repo is on '${currentBranch}', not ${defaultBranch}. Skipping pull.`,
      );
    }
  } catch {
    console.log("WARNING: Could not update parent repo.");
  }
}

console.log("Teardown complete.");
