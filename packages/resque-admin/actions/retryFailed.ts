import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminRetryFailed implements Action {
  name = "resque-admin:retry-failed";
  description =
    "Retries a failed job by moving it back to its original queue and removing it from the failed list. Accepts the failed job object as a JSON string.";
  inputs = z.object({
    password: secret(z.string()),
    failedJob: z.string().describe("JSON-stringified failed job object"),
  });
  web = { route: "/resque-admin/retry-failed", method: HTTP_METHOD.POST };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run(params: { failedJob: string }) {
    const parsed = JSON.parse(params.failedJob);
    await api.actions.retryAndRemoveFailed(parsed);
    return { success: true };
  }
}
