import fs from "node:fs";
import { unlink } from "node:fs/promises";
import { $, Glob } from "bun";
import { type Config as DrizzleMigrateConfig } from "drizzle-kit";
import { DefaultLogger, is, type LogWriter, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgTable } from "drizzle-orm/pg-core";
import path from "path";
import { Pool } from "pg";
import { api, logger } from "../api";
import { Initializer } from "../classes/Initializer";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import {
  formatConnectionStringForLogging,
  throwConnectionError,
} from "../util/connectionString";
import { globModuleExports } from "../util/glob";

const namespace = "db";

const SCHEMA_DIR = "schema";

/**
 * Check whether the project has any drizzle schema files to generate migrations from.
 * A freshly-scaffolded project (or one whose last schema file was deleted) has an
 * empty `schema/` directory, which `drizzle-kit generate` treats as a fatal error.
 *
 * @param schemaDir - Absolute path to the project's `schema/` directory. A missing
 * directory counts as empty rather than an error.
 * @returns `true` when at least one non-dotfile `.ts`/`.tsx`/`.js` file exists in the tree.
 */
async function hasSchemaFiles(schemaDir: string) {
  if (!fs.existsSync(schemaDir)) return false;

  const glob = new Glob("**/*.{ts,tsx,js,mjs,cjs}");
  for await (const file of glob.scan(schemaDir)) {
    if (path.basename(file).startsWith(".")) continue;
    return true;
  }

  return false;
}

/**
 * Build a registry of the project's Drizzle tables so the framework and plugins can
 * enumerate the database at runtime. Drizzle itself only ever sees the tables an action
 * imports directly, which leaves generic tooling — an admin dashboard, a schema
 * explorer — with nothing to introspect.
 *
 * Every `.ts` file under the directory is imported and its exports filtered down to
 * Drizzle tables. Keys are the *export* names (`users`), which may differ from the SQL
 * table names (`"users"`); use `getTableName()` when the SQL name is what you need.
 *
 * @param schemaDir - Absolute path to the project's `schema/` directory. A missing
 * directory yields an empty registry, so `schema/` remains an optional convention and
 * schema-less projects are unaffected.
 * @returns Map of export name to Drizzle table, ready to hand to `db.select().from()`
 * or `getTableConfig()`.
 * @throws {TypedError} With `ErrorType.SERVER_INITIALIZATION` if a schema file fails to import.
 */
export async function loadSchema(schemaDir: string) {
  return globModuleExports<PgTable>(schemaDir, (value): value is PgTable =>
    is(value, PgTable),
  );
}

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<DB["initialize"]>>;
  }
}

export class DB extends Initializer {
  constructor() {
    super(namespace);
  }

  async initialize() {
    const schema = await loadSchema(path.join(api.rootDir, SCHEMA_DIR));
    const tableCount = Object.keys(schema).length;
    logger.debug(`loaded ${tableCount} table(s) from ${SCHEMA_DIR}/`);

    const dbContainer = {} as {
      db: ReturnType<typeof drizzle>;
      pool: InstanceType<typeof Pool>;
    };
    return Object.assign(
      {
        generateMigrations: this.generateMigrations,
        clearDatabase: this.clearDatabase,
        schema,
      },
      dbContainer,
    );
  }

  async start() {
    api.db.pool = new Pool({
      connectionString: config.database.connectionString,
      ...config.database.pool,
    });

    class DrizzleLogger implements LogWriter {
      write(message: string) {
        logger.debug(message);
      }
    }

    api.db.db = drizzle(api.db.pool, {
      schema: api.db.schema,
      logger: new DefaultLogger({ writer: new DrizzleLogger() }),
    });

    try {
      await api.db.db.execute(sql`SELECT NOW()`);
    } catch (e) {
      throwConnectionError("database", config.database.connectionString, e);
    }

    if (config.database.autoMigrate) {
      try {
        const migrationsFolder = path.join(api.rootDir, "drizzle");
        const journalPath = path.join(
          migrationsFolder,
          "meta",
          "_journal.json",
        );
        if (!fs.existsSync(journalPath)) {
          fs.mkdirSync(path.dirname(journalPath), { recursive: true });
          fs.writeFileSync(journalPath, JSON.stringify({ entries: [] }));
          logger.info("created empty drizzle migrations journal");
        }
        await migrate(api.db.db, { migrationsFolder });
        logger.info("database migrated successfully");
      } catch (e) {
        throw new TypedError({
          type: ErrorType.SERVER_INITIALIZATION,
          message: `Cannot migrate database (${formatConnectionStringForLogging(config.database.connectionString)}): ${e}`,
        });
      }
    }

    logger.info(
      `database connection established (${formatConnectionStringForLogging(config.database.connectionString)})`,
    );
  }

  async stop() {
    if (api.db.db && api.db.pool) {
      try {
        await api.db.pool.end();
        logger.info("database connection closed");
      } catch (e) {
        logger.error("error closing database connection", e);
      }
    }
  }

  /**
   * Generate migrations for the database schema.
   * Learn more @ https://orm.drizzle.team/kit-docs/overview
   *
   * An empty `schema/` directory is a legitimate state for a new project, so this
   * is a no-op (rather than an error) when there is nothing to generate from.
   *
   * @throws {TypedError} With `ErrorType.SERVER_INITIALIZATION` if `drizzle-kit generate` fails.
   */
  async generateMigrations() {
    const schemaDir = path.join(api.rootDir, SCHEMA_DIR);
    const migrationsDir = path.join(api.rootDir, "drizzle");

    if (!(await hasSchemaFiles(schemaDir))) {
      logger.info(
        `no schema files found in ${SCHEMA_DIR}/ - nothing to generate`,
      );
      return;
    }

    // Paths stay relative — drizzle-kit concatenates `out` onto "./" when reading
    // existing snapshots, so an absolute path breaks on any non-empty migrations
    // folder. The child process is run with cwd set to the project root instead.
    const migrationConfig: DrizzleMigrateConfig = {
      dialect: "postgresql" as const,
      schema: path.join(SCHEMA_DIR, "*"),
      dbCredentials: {
        url: config.database.connectionString,
      },
      out: "drizzle",
    };

    const fileContent = `export default ${JSON.stringify(migrationConfig, null, 2)}`;
    const tmpfilePath = path.join(migrationsDir, "config.tmp.ts");

    try {
      await Bun.write(tmpfilePath, fileContent);
      // .nothrow() so a failing drizzle-kit surfaces as a TypedError with its
      // stderr, rather than a bare ShellError from the tagged template.
      const { exitCode, stdout, stderr } =
        await $`bun drizzle-kit generate --config ${tmpfilePath}`
          .cwd(api.rootDir)
          .nothrow();
      logger.trace(stdout.toString());
      if (exitCode !== 0) {
        throw new TypedError({
          message: `Failed to generate migrations: ${stderr.toString()}`,
          type: ErrorType.SERVER_INITIALIZATION,
        });
      }
    } finally {
      const filePointer = Bun.file(tmpfilePath);
      if (await filePointer.exists()) await unlink(tmpfilePath);
    }
  }

  /**
   * Erase all the tables in the active database.  Will fail on production environments.
   */
  async clearDatabase(restartIdentity = true, cascade = true) {
    if (Bun.env.NODE_ENV === "production") {
      throw new TypedError({
        message: "clearDatabase cannot be called in production",
        type: ErrorType.SERVER_INITIALIZATION,
      });
    }

    const { rows } = await api.db.db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = CURRENT_SCHEMA`,
    );

    for (const row of rows) {
      logger.debug(`truncating table ${row.tablename}`);
      await api.db.db.execute(
        sql.raw(
          `TRUNCATE TABLE "${row.tablename}" ${restartIdentity ? "RESTART IDENTITY" : ""} ${cascade ? "CASCADE" : ""} `,
        ),
      );
    }
  }
}
