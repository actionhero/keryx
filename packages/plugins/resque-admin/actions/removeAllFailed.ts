import {
  type Action,
  api,
  ErrorType,
  HTTP_METHOD,
  secret,
  TypedError,
} from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminRemoveAllFailed implements Action {
  name = "resque-admin:remove-all-failed";
  description =
    "Removes every job from the failed list without retrying them. Returns the number of jobs removed.";
  inputs = z.object({
    password: secret(z.string()),
  });
  web = {
    route: "/resque-admin/remove-all-failed",
    method: HTTP_METHOD.POST,
  };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run() {
    if (!api.resque) {
      throw new TypedError({
        message:
          "resque-admin requires the node-resque task backend (config.tasks.backend must be 'node-resque')",
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
    }
    const connection = api.resque.queue.connection;
    const key = connection.key("failed");
    const removed = await connection.redis.llen(key);
    await connection.redis.del(key);
    return { success: true, removed };
  }
}
