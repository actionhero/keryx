import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminQueue implements Action {
  name = "resque-admin:queue";
  description =
    "Returns jobs enqueued on a specific queue with pagination. Provide the queue name as a path parameter.";
  inputs = z.object({
    password: secret(z.string()),
    queue: z.string(),
    start: z.coerce.number().int().min(0).default(0),
    stop: z.coerce.number().int().min(0).default(99),
  });
  web = { route: "/resque-admin/queue/:queue", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run(params: { queue: string; start: number; stop: number }) {
    const jobs = await api.actions.queued(
      params.queue,
      params.start,
      params.stop,
    );
    return { queue: params.queue, jobs };
  }
}
