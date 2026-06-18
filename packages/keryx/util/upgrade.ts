import fs from "fs";
import os from "os";
import path from "path";
import * as readline from "readline";
import pkg from "../package.json";
import { readFileText, spawnProcess, writeFile } from "./runtime";
import {
  generateBuiltinActionContents,
  generateConfigFileContents,
  generateKeryxTsContents,
  generateOAuthTemplateContents,
  generateTsconfigContents,
} from "./scaffold";

export interface UpgradeOptions {
  dryRun: boolean;
  force: boolean;
}

interface UpgradeSummary {
  updated: number;
  created: number;
  skipped: number;
  upToDate: number;
}

async function promptOverwrite(filePath: string): Promise<"y" | "n" | "d"> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`  Overwrite ${filePath}? (y/n/d for diff) `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "d") resolve("d");
      else if (a === "y") resolve("y");
      else resolve("n");
    });
  });
}

async function showDiff(
  existingPath: string,
  newContent: string,
): Promise<void> {
  const tmpFile = path.join(
    os.tmpdir(),
    `keryx-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await writeFile(tmpFile, newContent);
  try {
    const { stdout: output } = await spawnProcess("diff", [
      "-u",
      existingPath,
      tmpFile,
    ]);
    if (output) {
      console.log(output);
    }
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

export async function upgradeProject(
  targetDir: string,
  options: UpgradeOptions,
): Promise<void> {
  // Validate this is a keryx project
  const pkgPath = path.join(targetDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      "No package.json found. Run this command from a Keryx project directory.",
    );
  }

  const projectPkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const deps = {
    ...projectPkg.dependencies,
    ...projectPkg.devDependencies,
  };
  if (!deps.keryx) {
    throw new Error(
      'This project does not have "keryx" as a dependency. Run this command from a Keryx project directory.',
    );
  }

  console.log(`Upgrading project files to match keryx v${pkg.version}\n`);

  // Generate all framework-owned file contents
  const files = new Map<string, string>();

  const configFiles = await generateConfigFileContents();
  for (const [p, content] of configFiles) files.set(p, content);

  const actionFiles = await generateBuiltinActionContents();
  for (const [p, content] of actionFiles) files.set(p, content);

  files.set("tsconfig.json", generateTsconfigContents());
  files.set("keryx.ts", await generateKeryxTsContents());

  const oauthTemplates = await generateOAuthTemplateContents();
  for (const [p, content] of oauthTemplates) files.set(p, content);

  const summary: UpgradeSummary = {
    updated: 0,
    created: 0,
    skipped: 0,
    upToDate: 0,
  };

  for (const [relativePath, newContent] of files) {
    const fullPath = path.join(targetDir, relativePath);

    if (!fs.existsSync(fullPath)) {
      // New file — create it
      if (!options.dryRun) {
        await writeFile(fullPath, newContent);
      }
      console.log(`  + created  ${relativePath}`);
      summary.created++;
      continue;
    }

    const existingContent = await readFileText(fullPath);
    if (existingContent === newContent) {
      console.log(`  ✓ up to date  ${relativePath}`);
      summary.upToDate++;
      continue;
    }

    // File differs
    if (options.dryRun) {
      console.log(`  ⚡ would update  ${relativePath}`);
      summary.updated++;
      continue;
    }

    if (options.force) {
      await writeFile(fullPath, newContent);
      console.log(`  ⚡ updated  ${relativePath}`);
      summary.updated++;
      continue;
    }

    // Interactive prompt
    let answer = await promptOverwrite(relativePath);
    while (answer === "d") {
      await showDiff(fullPath, newContent);
      answer = await promptOverwrite(relativePath);
    }

    if (answer === "y") {
      await writeFile(fullPath, newContent);
      console.log(`  ⚡ updated  ${relativePath}`);
      summary.updated++;
    } else {
      console.log(`  ⊘ skipped  ${relativePath}`);
      summary.skipped++;
    }
  }

  console.log(
    `\nUpdated ${summary.updated} file(s), created ${summary.created} file(s), ${summary.upToDate} already up to date` +
      (summary.skipped > 0 ? `, ${summary.skipped} skipped` : ""),
  );
}
