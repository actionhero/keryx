import os from "node:os";
import { Command } from "commander";
import path from "path";
import { Action, api, CONNECTION_TYPE, Connection, RUN_MODE } from "../api";
import { ExitCode } from "./../classes/ExitCode";
import { TypedError } from "./../classes/TypedError";
import { config } from "../config";
import { getValidTypes } from "./componentRegistry";
import { generateComponent } from "./generate";
import { globLoader } from "./glob";
import {
  interactiveScaffold,
  type ScaffoldOptions,
  scaffoldProject,
} from "./scaffold";
import { upgradeProject } from "./upgrade";

/**
 * Build a Commander program with all Keryx CLI commands registered.
 * Both the framework's own `keryx.ts` and scaffolded project `keryx.ts` files
 * call this function to ensure a consistent CLI experience.
 *
 * @param opts - Program metadata (name, description, version) from `package.json`
 * @returns A configured Commander program ready to call `.parse()`
 */
export async function buildProgram(opts: {
  name: string;
  description: string;
  version: string;
}): Promise<Command> {
  const program = new Command();
  program.name(opts.name);
  program.description(opts.description ?? "");
  program.version(opts.version);

  program
    .command("new [project-name]")
    .summary("Create a new Keryx project")
    .description("Scaffold a new Keryx application with project boilerplate")
    .option("-y, --yes", "Skip prompts and use defaults")
    .option("--no-interactive", "Skip prompts and use defaults")
    .option("--no-db", "Skip database setup files")
    .option("--no-example", "Skip example action")
    .option(
      "--force",
      "Scaffold into an existing directory (skips files that already exist)",
    )
    .action(async (projectName: string | undefined, cmdOpts) => {
      let options: ScaffoldOptions;

      if (cmdOpts.yes || cmdOpts.interactive === false) {
        projectName = projectName || "my-keryx-app";
        options = {
          includeDb: cmdOpts.db !== false,
          includeExample: cmdOpts.example !== false,
          force: cmdOpts.force === true,
        };
      } else {
        const result = await interactiveScaffold(projectName);
        projectName = result.projectName;
        options = { ...result.options, force: cmdOpts.force === true };
      }

      const targetDir = path.resolve(process.cwd(), projectName);

      console.log(`\nCreating new Keryx project: ${projectName}\n`);

      const files = await scaffoldProject(projectName, targetDir, options);
      files.forEach((f) => console.log(`  ${f}`));

      const steps = [`  cd ${projectName}`, `  cp .env.example .env`];
      if (options.includeDb) {
        steps.push(`  createdb ${projectName}`);
        steps.push(`  createdb ${projectName}-test`);
      }
      steps.push(`  bun install`);
      steps.push(`  bun dev`);

      console.log(`\nDone! To get started:\n\n${steps.join("\n")}\n`);
      process.exit(0);
    });

  program
    .command("upgrade")
    .summary(
      "Update framework-owned files to match the installed keryx version",
    )
    .option("--dry-run", "Show what would change without writing files")
    .option("--force", "Overwrite all framework files without confirmation")
    .option("-y, --yes", "Overwrite all framework files without confirmation")
    .action(async (cmdOpts) => {
      try {
        await upgradeProject(process.cwd(), {
          dryRun: cmdOpts.dryRun || false,
          force: cmdOpts.force || cmdOpts.yes || false,
        });
        process.exit(0);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command("build")
    .summary("Pre-generate swagger schemas for production")
    .description(
      "Run build-time code generation. Analyzes Action return types via ts-morph\n" +
        "and writes .cache/swagger-schemas.json so the server can skip this step at\n" +
        "startup. Recommended for memory-constrained environments (e.g., Docker).\n\n" +
        "Example Dockerfile usage:\n" +
        "  COPY . .\n" +
        "  RUN bun keryx.ts build\n" +
        '  CMD ["bun", "keryx.ts", "start"]',
    )
    .action(async () => {
      const { generateSwaggerSchemas, writeSchemasCache } = await import(
        "./swaggerSchemaGenerator"
      );
      const result = await generateSwaggerSchemas({
        rootDir: api.rootDir,
        packageDir: api.packageDir,
      });
      await writeSchemasCache(api.rootDir, result);
      console.log(
        `Generated ${Object.keys(result.responseSchemas).length} swagger response schemas`,
      );
      process.exit(0);
    });

  program
    .command("generate <type> <name>")
    .alias("g")
    .summary("Generate a new component")
    .description(
      `Scaffold a new component file.\n\nValid types: ${getValidTypes().join(", ")}\n\n` +
        "Examples:\n" +
        "  keryx generate action user:delete\n" +
        "  keryx generate initializer cache\n" +
        "  keryx generate middleware auth\n" +
        "  keryx generate channel notifications\n" +
        "  keryx generate ops UserOps\n" +
        "  keryx generate plugin analytics\n" +
        "  keryx g action hello",
    )
    .option("--dry-run", "Show what would be generated without writing files")
    .option("--force", "Overwrite existing files")
    .option("--no-test", "Skip generating a test file")
    .action(
      async (
        type: string,
        name: string,
        cmdOpts: { dryRun?: boolean; force?: boolean; test?: boolean },
      ) => {
        try {
          const rootDir = process.cwd();
          const files = await generateComponent(type, name, rootDir, {
            dryRun: cmdOpts.dryRun,
            force: cmdOpts.force,
            noTest: cmdOpts.test === false,
          });

          if (!cmdOpts.dryRun) {
            console.log("\nGenerated:");
            files.forEach((f) => console.log(`  ${f}`));
            console.log();
          }

          process.exit(0);
        } catch (e) {
          console.error((e as Error).message);
          process.exit(1);
        }
      },
    );

  program
    .command("start")
    .summary("Run the server")
    .description("Start the Keryx server")
    .action(async () => {
      await api.start();
    });

  // Load actions from the project directory
  let actions: Action[] = [];
  try {
    actions = await globLoader<Action>(path.join(api.rootDir, "actions"));
  } catch {
    // rootDir may not be set or project may not have actions yet
  }
  actions.forEach((action) => addActionToProgram(program, action));

  program
    .command("actions")
    .summary("List all actions")
    .action(async () => {
      const actionSpacing =
        actions.map((a) => a.name.length).reduce((a, b) => Math.max(a, b), 0) +
        2;
      const routeSpacing =
        actions
          .map((a) =>
            a.web ? a.web.route.toString().length + a.web.method.length : 0,
          )
          .reduce((a, b) => Math.max(a, b), 0) + 2;

      actions
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((action) => {
          console.log(
            `${action.name}${" ".repeat(actionSpacing - action.name.length)} ${action.web ? `[${action.web.method}] ${action.web.route}` : " "}${" ".repeat(routeSpacing - (action.web ? action.web.method.length + action.web.route.toString().length + 2 : 0))} ${action.description ?? ""}`,
          );
        });
    });

  return program;
}

export function addActionToProgram(program: Command, action: Action) {
  const command = program.command(action.name);
  command.summary(
    `Run action "${action.name}"${action.description ? ` (${action.description})` : ""}`,
  );
  command.description(
    `Run action "${action.name}"${action.description ? ` (${action.description})` : ""}

Inputs should be passed as options and will be formatted and validated per the action's definition.
The server will be initialized and started, except for initialized with the skipCLI flag (e.g. web server).`,
  );

  // Handle Zod schemas
  if (action.inputs && typeof action.inputs.parse === "function") {
    const zodSchema = action.inputs as any;

    // In Zod v4, object schemas have a .shape property
    if (zodSchema.shape && typeof zodSchema.shape === "object") {
      const shape = zodSchema.shape;

      for (const [name, fieldSchema] of Object.entries(shape)) {
        const isRequired = !isZodOptional(fieldSchema);
        const description =
          getZodDescription(fieldSchema) || `${name} parameter`;

        if (isRequired) {
          command.requiredOption(`--${name} <value>`, description);
        } else {
          command.option(`--${name} [value]`, description);
        }
      }
    }
  }

  command.option(
    "-q, --quiet",
    "disable all logging except for the action response.  You may also override the log level via environment variables",
    false,
  );

  command.action(runActionViaCLI);
}

async function runActionViaCLI(options: Record<string, string>, command: any) {
  const actionName: string = command.parent.args[0];
  if (options.quiet || config.server.cli.quiet) api.logger.quiet = true;

  await api.initialize();

  const action = api.actions.actions.find((a: Action) => a.name === actionName);
  if (!action) {
    exitWithError(`Action "${actionName}" not found`);
  }

  await api.start(RUN_MODE.CLI);

  const id = "cli:" + os.userInfo().username;
  const connection = new Connection(CONNECTION_TYPE.CLI, id);
  const params: Record<string, unknown> = { ...options };

  const { response, error } = await connection.act(actionName, params);
  const payload: { response: any; error?: any } = { response };
  let exitCode = ExitCode.success;

  if (error) {
    exitCode = ExitCode.error;
    if (error instanceof TypedError) {
      payload.error = {
        message: error.message,
        type: error.type,
        key: error.key,
        value: error.value,
        ...(config.server.cli.includeStackInErrors
          ? { stack: error.stack }
          : {}),
      };
    } else {
      payload.error = error;
    }
  }

  await api.signals.stop(
    "CLI_COMPLETE",
    exitCode,
    false,
    JSON.stringify(payload),
  );
}

function exitWithError(error: string | Error) {
  if (typeof error === "string") {
    error = new Error(error);
  }

  console.error(error.message);
  process.exit(1);
}

function isZodOptional(fieldSchema: any): boolean {
  if (!fieldSchema) return true;

  // Zod v4 has .isOptional() method
  if (typeof fieldSchema.isOptional === "function") {
    return fieldSchema.isOptional();
  }

  // Fallback for Zod v4: check the type in _zod.def
  const type = fieldSchema._zod?.def?.type;
  if (type === "optional" || type === "default") return true;

  return false;
}

function getZodDescription(fieldSchema: any): string | undefined {
  if (!fieldSchema) return undefined;

  // Zod v4: description is directly on the schema
  if (fieldSchema.description) return fieldSchema.description;

  // Fallback: check _zod.def.description
  const description = fieldSchema._zod?.def?.description;
  if (description) return description;

  return undefined;
}
