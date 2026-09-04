import { fileURLToPath } from "node:url";
import { type Action, config, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import type { AdminActionOptions } from "./options";

/**
 * Resolve the dashboard template's location on disk.
 *
 * Goes through `fileURLToPath` rather than reading `URL.pathname`, which stays
 * percent-encoded: installed under a directory containing a space, `pathname` yields
 * `.../my%20apps/...` and `Bun.file` looks for a directory literally named `my%20apps`.
 * The dashboard would 500 on a path that is perfectly legal on every OS — and on macOS
 * and Windows, spaces in paths are ordinary.
 *
 * @param base - Module URL to resolve against. Only overridden by tests.
 * @returns Absolute, decoded filesystem path to `templates/admin.html`.
 */
export function templatePath(base: string = import.meta.url) {
  return fileURLToPath(new URL("../templates/admin.html", base));
}

const dashboardPath = templatePath();

/**
 * Build the `admin:ui` action, which serves the dashboard itself.
 *
 * The UI is one self-contained HTML file with inline CSS and JavaScript, read off disk
 * and returned as a response. No bundler, no build step, no `dist/` directory, and no
 * CDN at runtime — the plugin publishes as raw TypeScript plus one `.html` file, so it
 * behaves the same whether it's installed from npm or linked from a workspace.
 *
 * The route itself is unauthenticated because it returns no data: every byte of content
 * arrives through the JSON actions, which are gated by the role middleware. Serving the
 * shell to an anonymous visitor gets them a login prompt, not a database.
 *
 * `extraMiddleware` is deliberately not applied here. A CSRF guard on a plain HTML GET
 * would leave the client unable to bootstrap.
 */
export function createAdminUIAction(_options: AdminActionOptions) {
  return class AdminUIAction implements Action {
    name = "admin:ui";
    description = "Serves the admin dashboard single-page UI.";
    inputs = z.object({});
    web = { route: config.admin.route, method: HTTP_METHOD.GET };
    mcp = { tool: false };

    async run() {
      // The role middleware isn't attached here, so this action has to check
      // `enabled` / `serveUi` itself — otherwise turning the dashboard or its HTML
      // shell off would still leave the route serving HTML and advertising that it
      // exists. Prefer omitting the action via `adminPlugin({ serveUi: false })`; this
      // is the safety net for a config-file override after registration.
      if (!config.admin.enabled || !config.admin.serveUi) {
        throw new TypedError({
          message: config.admin.enabled
            ? "Admin UI is not served"
            : "Admin dashboard is not enabled",
          type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
        });
      }

      const template = await Bun.file(dashboardPath).text();

      // The client needs to know where the API lives; both are server-side config it
      // can't derive from its own URL once apiRoute or route are customized.
      const html = template
        .replaceAll("{{API_ROUTE}}", config.server.web.apiRoute)
        .replaceAll("{{ADMIN_ROUTE}}", config.admin.route);

      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // The dashboard reflects live database state; a cached shell pointing at a
          // stale API shape is worse than a round trip.
          "Cache-Control": "no-store",
        },
      });
    }
  };
}
