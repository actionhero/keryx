import { Glob } from "bun";
import fs from "fs";
import Mustache from "mustache";
import path from "path";
import * as readline from "readline";
import pkg from "../package.json";
import { loadScaffoldTemplate as loadTemplate } from "./componentRegistry";

export interface ScaffoldOptions {
  includeDb: boolean;
  includeExample: boolean;
  /**
   * When true, scaffold into an existing directory instead of refusing.
   * Files that already exist on disk are left untouched (merge-skip); only
   * missing files are created. User files are never overwritten.
   */
  force?: boolean;
}

async function prompt(question: string, defaultValue: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function promptYesNo(
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await prompt(`${question} (${hint})`, defaultYes ? "y" : "n");
  return answer.toLowerCase().startsWith("y");
}

export async function interactiveScaffold(
  projectName?: string,
): Promise<{ projectName: string; options: ScaffoldOptions }> {
  if (!projectName) {
    projectName = await prompt("Project name:", "my-keryx-app");
  }

  const includeDb = await promptYesNo("Include database setup?", true);
  const includeExample = await promptYesNo("Include example action?", true);

  return { projectName, options: { includeDb, includeExample } };
}

/**
 * Generate OAuth template file contents from the framework templates directory.
 * Returns a Map of relativePath → content (e.g., "templates/oauth-authorize.html" → "...").
 */
export async function generateOAuthTemplateContents(): Promise<
  Map<string, string>
> {
  const result = new Map<string, string>();
  const oauthTemplates = [
    "oauth-authorize.html",
    "oauth-success.html",
    "oauth-common.css",
    "lion.svg",
  ];
  const sourceDir = path.join(import.meta.dir, "..", "templates");

  for (const file of oauthTemplates) {
    const content = await Bun.file(path.join(sourceDir, file)).text();
    result.set(`templates/${file}`, content);
  }

  return result;
}

/**
 * Generate config file contents from the framework config directory,
 * with imports rewritten for user projects.
 * Returns a Map of relativePath → content (e.g., "config/index.ts" → "...").
 */
export async function generateConfigFileContents(): Promise<
  Map<string, string>
> {
  const result = new Map<string, string>();
  const configDir = path.join(import.meta.dir, "..", "config");
  const glob = new Glob("**/*.ts");

  for await (const file of glob.scan(configDir)) {
    let content = await Bun.file(path.join(configDir, file)).text();

    // Rewrite relative imports to package imports
    content = content.replace(
      /from ["']\.\.\/\.\.\/util\/config["']/g,
      'from "keryx"',
    );
    content = content.replace(
      /from ["']\.\.\/util\/config["']/g,
      'from "keryx"',
    );
    content = content.replace(
      /from ["']\.\.\/classes\/Logger["']/g,
      'from "keryx"',
    );
    content = content.replace(
      /from ["']\.\.\/classes\/Plugin["']/g,
      'from "keryx"',
    );

    // In index.ts, change `export const config` to `export default`
    // and remove the KeryxConfig interface export (it comes from the package)
    if (file === "index.ts") {
      content = content.replace("export const config =", "export default");
      content = content.replace(
        /\nexport interface KeryxConfig \{[\s\S]*?\}\n/,
        "\n",
      );
      // Remove the KeryxPlugin import (only used by the stripped KeryxConfig interface)
      content = content.replace(
        /import type \{ KeryxPlugin \} from ["']keryx["'];\n/,
        "",
      );
    }

    result.set(`config/${file}`, content);
  }

  return result;
}

/**
 * Generate built-in action file contents (status.ts, swagger.ts)
 * with imports rewritten for user projects.
 * Returns a Map of relativePath → content (e.g., "actions/status.ts" → "...").
 */
export async function generateBuiltinActionContents(): Promise<
  Map<string, string>
> {
  const result = new Map<string, string>();
  const builtinActions = ["status.ts", "swagger.ts"];
  const actionsDir = path.join(import.meta.dir, "..", "actions");

  for (const file of builtinActions) {
    let content = await Bun.file(path.join(actionsDir, file)).text();

    // Rewrite relative imports to package imports
    content = content.replace(/from ["']\.\.\/api["']/g, 'from "keryx"');
    content = content.replace(
      /from ["']\.\.\/classes\/Action["']/g,
      'from "keryx"',
    );
    content = content.replace(
      /from ["']\.\.\/package\.json["']/g,
      'from "../package.json"',
    );

    result.set(`actions/${file}`, content);
  }

  return result;
}

/**
 * Generate the tsconfig.json content for scaffolded projects.
 */
export function generateTsconfigContents(): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext"],
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "bundler",
          types: ["bun-types"],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          isolatedModules: true,
          verbatimModuleSyntax: true,
          noImplicitAny: true,
          noImplicitReturns: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noFallthroughCasesInSwitch: true,
          forceConsistentCasingInFileNames: true,
          allowImportingTsExtensions: true,
        },
        include: ["**/*.ts"],
        exclude: ["node_modules", "drizzle"],
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Generate the canonical project `keryx.ts` content from the scaffold template.
 * Used by both `scaffoldProject()` and `upgradeProject()`.
 */
export async function generateKeryxTsContents(): Promise<string> {
  return loadTemplate("keryx.ts.mustache");
}

/**
 * Generate auth scaffold file contents: schema, ops, middleware, and actions
 * for a working sign-up / sign-in / sign-out / me flow.
 * Returns a Map of relativePath → content.
 */
export async function generateAuthScaffoldContents(): Promise<
  Map<string, string>
> {
  const result = new Map<string, string>();

  const files: [string, string][] = [
    ["schema/users.ts", "schema-users.ts.mustache"],
    ["ops/UserOps.ts", "ops-user.ts.mustache"],
    ["middleware/session.ts", "middleware-session.ts.mustache"],
    ["actions/user.ts", "actions-user.ts.mustache"],
    ["actions/session.ts", "actions-session.ts.mustache"],
    ["actions/me.ts", "actions-me.ts.mustache"],
  ];

  for (const [filePath, templateName] of files) {
    const content = await loadTemplate(templateName);
    result.set(filePath, content);
  }

  // Pre-generated migration for the users table so the project works out of the box
  result.set(
    "drizzle/0000_users.sql",
    `CREATE TABLE IF NOT EXISTS "users" (\n\t"id" serial PRIMARY KEY NOT NULL,\n\t"name" varchar(256) NOT NULL,\n\t"email" text NOT NULL,\n\t"password_hash" text NOT NULL,\n\t"created_at" timestamp DEFAULT now() NOT NULL,\n\t"updated_at" timestamp DEFAULT now() NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX IF NOT EXISTS "name_idx" ON "users" ("name");--> statement-breakpoint\nCREATE UNIQUE INDEX IF NOT EXISTS "email_idx" ON "users" ("email");\n`,
  );

  result.set(
    "drizzle/meta/_journal.json",
    JSON.stringify(
      {
        version: "5",
        dialect: "pg",
        entries: [
          {
            idx: 0,
            version: "5",
            when: 1711324460394,
            tag: "0000_users",
            breakpoints: true,
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );

  return result;
}

export async function scaffoldProject(
  projectName: string,
  targetDir: string,
  options: ScaffoldOptions,
): Promise<string[]> {
  const keryxVersion = pkg.version;
  const createdFiles: string[] = [];

  const dirExists = fs.existsSync(targetDir);
  if (dirExists && !options.force) {
    throw new Error(`Directory "${projectName}" already exists`);
  }
  if (dirExists && options.force) {
    console.log(
      `  ⚠ scaffolding into existing directory — existing files will be preserved`,
    );
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const view = { projectName, keryxVersion };

  const write = async (filePath: string, content: string) => {
    const fullPath = path.join(targetDir, filePath);
    if (options.force && fs.existsSync(fullPath)) {
      console.log(`  ⊘ skipped  ${filePath}`);
      return;
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    await Bun.write(fullPath, content);
    createdFiles.push(filePath);
  };

  const writeTemplate = async (filePath: string, templateName: string) => {
    const template = await loadTemplate(templateName);
    await write(filePath, Mustache.render(template, view));
  };

  // --- Always generated ---

  // package.json is built programmatically (conditional deps/scripts)
  await write(
    "package.json",
    JSON.stringify(
      {
        name: projectName,
        version: "0.0.1",
        description: `${projectName} — powered by Keryx`,
        module: "index.ts",
        type: "module",
        private: true,
        license: "MIT",
        bin: { keryx: "keryx.ts" },
        scripts: {
          start: "bun keryx.ts start",
          dev: "bun --watch keryx.ts start",
          ...(options.includeDb ? { migrations: "bun run migrations.ts" } : {}),
          lint: "tsc && biome check .",
          format: "tsc && biome check --write .",
        },
        dependencies: {
          keryx: `^${keryxVersion}`,
          zod: "^4.3.6",
          ...(options.includeDb
            ? {
                "drizzle-orm": "^0.45.1",
                "drizzle-zod": "^0.8.3",
              }
            : {}),
        },
        devDependencies: {
          "@biomejs/biome": "^2.4.8",
          "@types/bun": "latest",
          ...(options.includeDb ? { "drizzle-kit": "^0.20.18" } : {}),
        },
      },
      null,
      2,
    ) + "\n",
  );

  await write("tsconfig.json", generateTsconfigContents());
  await write(
    "biome.json",
    JSON.stringify(
      {
        $schema: "https://biomejs.dev/schemas/2.4.8/schema.json",
        assist: { actions: { source: { organizeImports: "on" } } },
        formatter: {
          enabled: true,
          indentStyle: "space",
          indentWidth: 2,
          lineWidth: 80,
        },
        linter: { enabled: false },
        javascript: {
          formatter: { quoteStyle: "double", trailingCommas: "all" },
        },
        files: {
          includes: [
            "**",
            "!**/node_modules",
            "!**/types/",
            "!**/.cache/",
            "!**/bun.lockb",
            "!**/templates/**",
          ],
        },
      },
      null,
      2,
    ) + "\n",
  );

  await writeTemplate("index.ts", "index.ts.mustache");
  await write("keryx.ts", await generateKeryxTsContents());
  await writeTemplate(".env.example", "env.example.mustache");
  await writeTemplate(".gitignore", "gitignore.mustache");

  // Copy config files from the framework, adjusting imports for user projects
  const configFiles = await generateConfigFileContents();
  for (const [filePath, content] of configFiles) {
    await write(filePath, content);
  }

  // Create empty directories with .gitkeep
  await write("initializers/.gitkeep", "");
  await write("middleware/.gitkeep", "");
  await write("channels/.gitkeep", "");

  // --- Database setup ---

  if (options.includeDb) {
    await writeTemplate("migrations.ts", "migrations.ts.mustache");

    // Auth example replaces the .gitkeep placeholders with real files below;
    // only write placeholders when not including auth.
    if (!options.includeExample) {
      await write("schema/.gitkeep", "");
      await write(
        "drizzle/meta/_journal.json",
        JSON.stringify({ entries: [] }),
      );
    }
  }

  // --- Built-in actions (always included) ---
  const actionFiles = await generateBuiltinActionContents();
  for (const [filePath, content] of actionFiles) {
    await write(filePath, content);
  }

  // --- OAuth templates (always included) ---
  const oauthTemplates = await generateOAuthTemplateContents();
  for (const [filePath, content] of oauthTemplates) {
    await write(filePath, content);
  }

  // --- Static assets (API documentation) ---
  const swaggerHtml = await loadTemplate("assets-index.html");
  await write("assets/index.html", swaggerHtml);

  // --- Example: auth actions (when db) or hello action (when no db) ---

  if (options.includeExample) {
    if (options.includeDb) {
      // Full auth starter: sign up, sign in, sign out, and a protected /me endpoint
      const authFiles = await generateAuthScaffoldContents();
      for (const [filePath, content] of authFiles) {
        await write(filePath, content);
      }
    } else {
      // No DB — fall back to the simple hello action
      await writeTemplate("actions/hello.ts", "hello-action.ts.mustache");
    }
  }

  return createdFiles;
}
