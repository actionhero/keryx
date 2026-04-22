import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminOverview implements Action {
  name = "resque-admin:overview";
  description =
    "Returns an overview of the Resque task system including queue lengths, worker status, stats, leader, and failed job count. Requires the resque admin password.";
  inputs = z.object({
    password: secret(z.string()),
  });
  web = { route: "/resque-admin/overview", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run() {
    const [details, failedCount] = await Promise.all([
      api.actions.taskDetails(),
      api.actions.failedCount(),
    ]);

    return { ...details, failedCount };
  }
}
