import type { Action } from "keryx";
import { z } from "zod";

export class DemoAlwaysFails implements Action {
  name = "demo:alwaysFails";
  description =
    "Demo task: always throws. Enqueued on the 'critical' queue and via delayed schedulers to populate the Failed and Delayed tabs in the resque-admin dev UI.";
  inputs = z.object({});
  mcp = { tool: false };
  task = { queue: "critical" };

  async run() {
    throw new Error("demo:alwaysFails — this task is designed to fail");
  }
}
