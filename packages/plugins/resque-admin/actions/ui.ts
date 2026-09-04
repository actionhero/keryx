import { type Action, config, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";

const dashboardPath = new URL("../templates/dashboard.html", import.meta.url)
  .pathname;

export class ResqueAdminUI implements Action {
  name = "resque-admin:ui";
  description = "Serves the Resque Admin single-page dashboard UI.";
  inputs = z.object({});
  web = { route: "/resque-admin", method: HTTP_METHOD.GET };
  mcp = { tool: false };

  async run() {
    // Prefer omitting this action via `createResqueAdminPlugin({ serveUi: false })`.
    // This check is the safety net for a config-file override after registration.
    if (!config.resqueAdmin.serveUi) {
      throw new TypedError({
        message: "Resque admin UI is not served",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }

    const template = await Bun.file(dashboardPath).text();
    const html = template.replace("{{API_ROUTE}}", config.server.web.apiRoute);
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
