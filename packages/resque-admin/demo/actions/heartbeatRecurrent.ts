import type { Action } from "keryx";
import { z } from "zod";

export class DemoHeartbeatRecurrent implements Action {
  name = "demo:heartbeatRecurrent";
  description =
    "Demo recurrent task: runs every 30 seconds and succeeds. Demonstrates successful recurring activity in the resque-admin dev UI.";
  inputs = z.object({});
  mcp = { tool: false };
  task = { frequency: 1000 * 30, queue: "scheduler" };

  async run() {
    return { timestamp: new Date().toISOString() };
  }
}
