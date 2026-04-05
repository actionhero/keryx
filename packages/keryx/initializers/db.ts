import { unlink } from "node:fs/promises";
import { $, SQL } from "bun";
import { type Config as DrizzleMigrateConfig } from "drizzle-kit";
import { DefaultLogger, type LogWriter, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import path from "path";
import { api, logger } from "../api";
import { Initializer } from "../classes/Initializer";
import { ErrorType, TypedError } from "../classes/TypedError";
import { config } from "../config";
import { formatConnectionStringForLogging } from "../util/connectionString";

const namespace = "db";

declare module "../classes/API" {
  export interface API {
    [namespace]: Awaited<ReturnType<DB["initialize"]>>;
  }
}

/**
 * Cached Bun.sql client instance. Reused across start/stop cycles to avoid
 * a Bun.sql issue where rapidly creating many SQL instances can exhaust
 * internal resources.
 */
let cachedClient: InstanceType<typeof SQL> | undefined;
let cachedConnectionString: string | undefined;

export class DB extends Initializer {
  constructor() {
    super(namespace);
    this.loadPriority = 100;
    this.startPriority = 100;
    this.stopPriority = 910;
  }

  async initialize() {
    const dbContainer = {} as {
      db: ReturnType<typeof drizzle>;
      client: InstanceType<typeof SQL>;
    };
    return Object.assign(
      {
        generateMigrations: this.generateMigrations,
        clearDatabase: this.clearDatabase,
      },
      dbContainer,
    );
  }

  async start() {
    // Reuse the cached client if the connection string hasn't changed,
    // otherwise close the old one and create a new one.
    if (
      cachedClient &&
      cachedConnectionString === config.database.connectionString
    ) {
      api.db.client = cachedClient;
    } else {
      if (cachedClient) {
        try {
          await cachedClient.close();
        } catch {
          // ignore close errors on stale clients
        }
      }
      api.db.client = new SQL({
        url: config.database.connectionString,
        max: config.database.pool.max,
        idleTimeout: Math.floor(config.database.pool.idleTimeoutMillis / 1000),
        ...(config.database.pool.connectionTimeoutMillis > 0
          ? {
              connectionTimeout: Math.floor(
                config.database.pool.connectionTimeoutMillis / 1000,
              ),
            }
          : {}),
      });
      cachedClient = api.db.client;
      cachedConnectionString = config.database.connectionString;
    }

    class DrizzleLogger implements LogWriter {
      write(message: string) {
        logger.debug(message);
      }
    }

    api.db.db = drizzle({
      client: api.db.client,
      logger: new DefaultLogger({ writer: new DrizzleLogger() }),
    });

    try {
      await api.db.db.execute(sql`SELECT NOW()`);
    } catch (e) {
      throw new TypedError({
        type: ErrorType.SERVER_INITIALIZATION,
        message: `Cannot connect to database (${formatConnectionStringForLogging(config.database.connectionString)}): ${e}`,
      });
    }

    if (config.database.autoMigrate) {
      try {
        const migrationsFolder = path.join(api.rootDir, "drizzle");
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
    // Don't close the Bun.sql client here — it's cached for reuse across
    // start/stop cycles to work around a Bun.sql issue with rapid
    // connection churn. The client is closed when the connection
    // string changes or the process exits.
    logger.info("database connection released");
  }

  /**
   * Generate migrations for the database schema.
   * Learn more @ https://orm.drizzle.team/kit-docs/overview
   */
  async generateMigrations() {
    const migrationConfig: DrizzleMigrateConfig = {
      dialect: "postgresql" as const,
      schema: path.join("schema", "*"),
      dbCredentials: {
        url: config.database.connectionString,
      },
      out: path.join("drizzle"),
    };

    const fileContent = `export default ${JSON.stringify(migrationConfig, null, 2)}`;
    const tmpfilePath = path.join(api.rootDir, "drizzle", "config.tmp.ts");

    try {
      await Bun.write(tmpfilePath, fileContent);
      const { exitCode, stdout, stderr } =
        await $`bun drizzle-kit generate --config ${tmpfilePath}`;
      logger.trace(stdout.toString());
      if (exitCode !== 0) {
        {
          throw new TypedError({
            message: `Failed to generate migrations: ${stderr.toString()}`,
            type: ErrorType.SERVER_INITIALIZATION,
          });
        }
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

    const rows = await api.db.db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = CURRENT_SCHEMA`,
    );

    for (const row of rows) {
      logger.debug(`truncating table ${(row as any).tablename}`);
      await api.db.db.execute(
        sql.raw(
          `TRUNCATE TABLE "${(row as any).tablename}" ${restartIdentity ? "RESTART IDENTITY" : ""} ${cascade ? "CASCADE" : ""} `,
        ),
      );
    }
  }
}
