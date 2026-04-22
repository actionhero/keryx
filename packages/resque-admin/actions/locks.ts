import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminLocks implements Action {
  name = "resque-admin:locks";
  description =
    "Returns all resque locks, including job locks and worker locks.";
  inputs = z.object({
    password: secret(z.string()),
  });
  web = { route: "/resque-admin/locks", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run() {
    const locks = await api.actions.locks();
    return { locks };
  }
}
