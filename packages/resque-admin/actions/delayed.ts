import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminDelayed implements Action {
  name = "resque-admin:delayed";
  description =
    "Returns all delayed jobs organized by the timestamp at which they are scheduled to run. Note: this can be slow with many delayed jobs.";
  inputs = z.object({
    password: secret(z.string()),
  });
  web = { route: "/resque-admin/delayed", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run() {
    const delayed = await api.actions.allDelayed();
    return { delayed };
  }
}
