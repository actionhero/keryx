import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminRemoveFailed implements Action {
  name = "resque-admin:remove-failed";
  description =
    "Removes a failed job from the failed list without retrying it. Accepts the failed job object as a JSON string.";
  inputs = z.object({
    password: secret(z.string()),
    failedJob: z.string().describe("JSON-stringified failed job object"),
  });
  web = { route: "/resque-admin/remove-failed", method: HTTP_METHOD.POST };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run(params: { failedJob: string }) {
    const parsed = JSON.parse(params.failedJob);
    await api.actions.removeFailed(parsed);
    return { success: true };
  }
}
