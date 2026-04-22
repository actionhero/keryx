import { type Action, HTTP_METHOD } from "keryx";
import { config } from "keryx/config";
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
    const apiRoute = (
      config as unknown as { server: { web: { apiRoute: string } } }
    ).server.web.apiRoute;

    const template = await Bun.file(dashboardPath).text();
    const html = template.replace("{{API_ROUTE}}", apiRoute);
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
