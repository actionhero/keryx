import { api, config, Initializer, logger } from "keryx";
import { setupDemoTables } from "../tables";

/**
 * Dev-only initializer that creates, registers, and seeds the demo tables so
 * `bun dev:admin` opens onto a dashboard with real data in it.
 *
 * Runs after `db` so `api.db.db` is connected and `api.db.schema` exists.
 */
export class SeedDemoTables extends Initializer {
  constructor() {
    super("seedDemoTables");
    this.dependsOn = ["db"];
    this.declaresAPIProperty = false;
  }

  async start() {
    await setupDemoTables();

    logger.info(
      `[admin demo] dashboard ready at http://localhost:${config.server.web.port}${config.server.web.apiRoute}${config.admin.route}`,
    );
    logger.info(
      `[admin demo] tables registered: ${Object.keys(api.db.schema).join(", ")}`,
    );
  }
}
