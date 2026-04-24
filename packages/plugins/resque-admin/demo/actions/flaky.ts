import type { Action } from "keryx";
import { z } from "zod";

export class DemoFlaky implements Action {
  name = "demo:flaky";
  description =
    "Demo task: succeeds ~60% of the time, throws otherwise. Used to populate the Failed tab in the resque-admin dev UI.";
  inputs = z.object({});
  mcp = { tool: false };
  task = { queue: "default" };

  async run() {
    await Bun.sleep(100 + Math.floor(Math.random() * 400));
    if (Math.random() < 0.4) {
      throw new Error("demo:flaky randomly failed");
    }
    return { ok: true };
  }
}
