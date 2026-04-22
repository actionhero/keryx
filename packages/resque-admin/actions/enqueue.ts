import { type Action, api, HTTP_METHOD, secret } from "keryx";
import { z } from "zod";
import { ResqueAdminPasswordMiddleware } from "../middleware/password";

export class ResqueAdminEnqueue implements Action {
  name = "resque-admin:enqueue";
  description =
    "Manually enqueues an action as a background task. Provide the action name, optional JSON inputs, and optional queue name.";
  inputs = z.object({
    password: secret(z.string()),
    actionName: z.string().describe("The name of the action to enqueue"),
    inputs: z
      .string()
      .default("{}")
      .describe("JSON-stringified inputs for the action"),
    queue: z.string().optional().describe("Queue name (defaults to 'default')"),
  });
  web = { route: "/resque-admin/enqueue", method: HTTP_METHOD.POST };
  mcp = { tool: false };
  middleware = [ResqueAdminPasswordMiddleware];

  async run(params: { actionName: string; inputs: string; queue?: string }) {
    const parsedInputs = JSON.parse(params.inputs);
    await api.actions.enqueue(params.actionName, parsedInputs, params.queue);
    return {
      success: true,
      actionName: params.actionName,
      queue: params.queue ?? "default",
    };
  }
}
