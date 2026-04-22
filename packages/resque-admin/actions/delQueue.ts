import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminDelQueue implements Action {
  name = "resque-admin:del-queue";
  description =
    "Deletes an entire queue and all jobs stored on it. This is destructive and cannot be undone.";
  inputs = z.object({
    password: secret(z.string()),
    queue: z.string(),
  });
  web = { route: "/resque-admin/del-queue", method: HTTP_METHOD.POST };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run(params: { queue: string }) {
    await api.actions.delQueue(params.queue);
    return { success: true, deleted: params.queue };
  }
}
