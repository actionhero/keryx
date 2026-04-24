import type { Action } from "keryx";
import { z } from "zod";

export class DemoSlowSuccess implements Action {
  name = "demo:slowSuccess";
  description =
    "Demo task: sleeps for a random interval then returns. Used to generate visible queue backlog and steady worker throughput in the resque-admin dev UI.";
  inputs = z.object({});
  mcp = { tool: false };
  task = { queue: "default" };

  async run() {
    const ms = 500 + Math.floor(Math.random() * 2500);
    await Bun.sleep(ms);
    return { slept: ms };
  }
}
