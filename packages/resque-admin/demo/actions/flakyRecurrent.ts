import type { Action } from "keryx";
import { z } from "zod";

export class DemoFlakyRecurrent implements Action {
  name = "demo:flakyRecurrent";
  description =
    "Demo recurrent task: runs every 45 seconds and always throws. Demonstrates recurring failures in the resque-admin dev UI.";
  inputs = z.object({});
  mcp = { tool: false };
  task = { frequency: 1000 * 45, queue: "scheduler" };

  async run() {
    throw new Error("demo:flakyRecurrent — scheduled failure");
  }
}
