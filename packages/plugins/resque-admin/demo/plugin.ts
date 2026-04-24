import type { KeryxPlugin } from "keryx";
import { DemoAlwaysFails } from "./actions/alwaysFails";
import { DemoFlaky } from "./actions/flaky";
import { DemoFlakyRecurrent } from "./actions/flakyRecurrent";
import { DemoHeartbeatRecurrent } from "./actions/heartbeatRecurrent";
import { DemoSlowSuccess } from "./actions/slowSuccess";
import { SeedDemoTasks } from "./initializers/seedDemo";

/**
 * Dev-only plugin that seeds the resque-admin dashboard with a realistic mix
 * of background tasks (queued, succeeding, failing, delayed, recurrent).
 *
 * Intentionally not exported from the package entry point — it is wired into
 * `dev.ts` directly and excluded from the published npm package via the
 * `files` allowlist in package.json.
 */
export const demoPlugin: KeryxPlugin = {
  name: "resque-admin-demo",
  version: "0.0.0",
  actions: [
    DemoSlowSuccess,
    DemoFlaky,
    DemoAlwaysFails,
    DemoHeartbeatRecurrent,
    DemoFlakyRecurrent,
  ],
  initializers: [SeedDemoTasks],
};
