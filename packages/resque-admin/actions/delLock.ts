import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminDelLock implements Action {
  name = "resque-admin:del-lock";
  description = "Deletes a specific resque lock by its key.";
  inputs = z.object({
    password: secret(z.string()),
    lock: z.string().describe("The lock key to delete"),
  });
  web = { route: "/resque-admin/del-lock", method: HTTP_METHOD.POST };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run(params: { lock: string }) {
    await api.actions.delLock(params.lock);
    return { success: true, deleted: params.lock };
  }
}
