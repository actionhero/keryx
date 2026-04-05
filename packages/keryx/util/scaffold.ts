import { $, Glob } from "bun";
import fs from "fs";
import Mustache from "mustache";
import path from "path";
import * as readline from "readline";
import pkg from "../package.json";

export interface ScaffoldOptions {
  includeDb: boolean;
  includeExample: boolean;
}

const templatesDir = path.join(import.meta.dir, "..", "templates", "scaffold");

async function loadTemplate(name: string): Promise<string> {
  return Bun.file(path.join(templatesDir, name)).text();
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

  return result;
}

export async function scaffoldProject(
  projectName: string,
  targetDir: string,
  options: ScaffoldOptions,
): Promise<string[]> {
  const keryxVersion = pkg.version;
  const createdFiles: string[] = [];

  if (fs.existsSync(targetDir)) {
    throw new Error(`Directory "${projectName}" already exists`);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const view = { projectName, keryxVersion };

  const write = async (filePath: string, content: string) => {
    const fullPath = path.join(targetDir, filePath);
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
          zod: pkg.peerDependencies.zod,
          ...(options.includeDb
            ? {
                "drizzle-orm": pkg.peerDependencies["drizzle-orm"],
              }
            : {}),
        },
        devDependencies: {
          "@biomejs/biome": "^2.4.8",
          "@types/bun": "latest",
          ...(options.includeDb
            ? { "drizzle-kit": pkg.devDependencies["drizzle-kit"] }
            : {}),
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
      await write("drizzle/.gitkeep", "");
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

      // Install deps so drizzle-kit can resolve drizzle-orm/pg-core.
      // Temporarily remove keryx from package.json since it may not be published yet.
      const pkgJsonPath = path.join(targetDir, "package.json");
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      const savedDeps = { ...pkgJson.dependencies };
      delete pkgJson.dependencies.keryx;
      await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
      await $`bun install`.cwd(targetDir).quiet();
      pkgJson.dependencies = savedDeps;
      await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

      // Generate the initial migration from the schema via drizzle-kit
      const drizzleDir = path.join(targetDir, "drizzle");
      fs.mkdirSync(drizzleDir, { recursive: true });
      const drizzleConfig = {
        dialect: "postgresql" as const,
        schema: path.join(targetDir, "schema", "*"),
        out: drizzleDir,
      };
      const tmpConfigPath = path.join(targetDir, "drizzle.config.tmp.ts");
      try {
        await Bun.write(
          tmpConfigPath,
          `export default ${JSON.stringify(drizzleConfig, null, 2)}`,
        );
        const { exitCode, stderr } =
          await $`bunx drizzle-kit generate --config ${tmpConfigPath}`
            .cwd(targetDir)
            .quiet();
        if (exitCode !== 0) {
          throw new Error(
            `Failed to generate migrations: ${stderr.toString()}`,
          );
        }
        // Add generated migration files to the created files list
        const drizzleGlob = new Glob("**/*");
        for await (const file of drizzleGlob.scan(drizzleDir)) {
          if (!file.endsWith(".tmp.ts")) {
            createdFiles.push(`drizzle/${file}`);
          }
        }
      } finally {
        if (await Bun.file(tmpConfigPath).exists()) {
          fs.unlinkSync(tmpConfigPath);
        }
      }
    } else {
      // No DB — fall back to the simple hello action
      await writeTemplate("actions/hello.ts", "hello-action.ts.mustache");
    }
  }

  return createdFiles;
}
