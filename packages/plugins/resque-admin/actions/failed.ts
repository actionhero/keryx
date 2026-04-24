import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminFailed implements Action {
  name = "resque-admin:failed";
  description =
    "Returns failed jobs with pagination. Includes the total failed count and job details between start and stop indices.";
  inputs = z.object({
    password: secret(z.string()),
    start: z.coerce.number().int().min(0).default(0),
    stop: z.coerce.number().int().min(0).default(99),
  });
  web = { route: "/resque-admin/failed", method: HTTP_METHOD.GET };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run(params: { start: number; stop: number }) {
    const [totalFailed, jobs] = await Promise.all([
      api.actions.failedCount(),
      api.actions.failed(params.start, params.stop),
    ]);

    return { totalFailed, jobs };
  }
}
