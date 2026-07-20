import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../../config";
import {
  bundleMcpAppClient,
  DEFAULT_MCP_APP_SHELL,
  injectThemeCss,
  resolveMcpAppHtml,
} from "../../util/mcpAppBundler";
import { resetThemeCache } from "../../util/theme";

const fixture = new URL("../fixtures/mcpAppClient.ts", import.meta.url);
const themeFixture = import.meta.dir + "/../fixtures/theme.ts";
const EMPTY_MODULE_SCRIPT = /<script\s+type=["']module["']>\s*<\/script>/;

describe("mcpAppBundler", () => {
  describe("resolveMcpAppHtml", () => {
    test("returns html verbatim when no client is set", async () => {
      expect(await resolveMcpAppHtml({ html: "<p>hi</p>" })).toBe("<p>hi</p>");
    });

    test("throws when neither client nor html is set", async () => {
      await expect(resolveMcpAppHtml({})).rejects.toThrow(
        /requires either `client` or `html`/,
      );
    });

    test("bundles the client into the default shell", async () => {
      const html = await resolveMcpAppHtml({ client: fixture });
      expect(html).toContain("<!doctype html>");
      expect(html).toContain('<div id="root">');
      expect(html).toContain("MCP_APP_FIXTURE_MARKER");
      // The empty module script placeholder was replaced with the bundle.
      expect(html).not.toMatch(EMPTY_MODULE_SCRIPT);
    });

    test("inlines the bundle into a provided shell's empty module script", async () => {
      const shell =
        '<html><body><main>custom</main><script type="module"></script></body></html>';
      const html = await resolveMcpAppHtml({ client: fixture, html: shell });
      expect(html).toContain("<main>custom</main>");
      expect(html).toContain("MCP_APP_FIXTURE_MARKER");
      expect(html).not.toMatch(EMPTY_MODULE_SCRIPT);
    });

    test("inlines the bundle at a placeholder comment", async () => {
      const shell =
        '<html><body><script type="module">/* MCP_APP_CLIENT */</script></body></html>';
      const html = await resolveMcpAppHtml({ client: fixture, html: shell });
      expect(html).toContain("MCP_APP_FIXTURE_MARKER");
      expect(html).not.toContain("/* MCP_APP_CLIENT */");
    });

    test("default shell is self-contained (no external origins)", async () => {
      const html = await resolveMcpAppHtml({ client: fixture });
      expect(DEFAULT_MCP_APP_SHELL).toContain('<div id="root">');
      expect(html).not.toContain("https://");
    });
  });

  describe("bundleMcpAppClient", () => {
    test("bundles a browser entrypoint to a script string", async () => {
      const script = await bundleMcpAppClient(fixture);
      expect(script.length).toBeGreaterThan(0);
      expect(script).toContain("MCP_APP_FIXTURE_MARKER");
    });

    test("throws a helpful error for a missing entrypoint", async () => {
      await expect(
        bundleMcpAppClient("/nonexistent/does-not-exist.ts"),
      ).rejects.toThrow(/Failed to build MCP App client/);
    });
  });

  describe("injectThemeCss", () => {
    test("replaces the MCP_APP_THEME placeholder with the theme", () => {
      const shell = "<style>base{}/* MCP_APP_THEME */</style>";
      expect(injectThemeCss(shell, ".a{color:red}")).toBe(
        "<style>base{}.a{color:red}</style>",
      );
    });

    test("removes the placeholder when the theme is empty", () => {
      const shell = "<style>base{}/* MCP_APP_THEME */</style>";
      expect(injectThemeCss(shell, "")).toBe("<style>base{}</style>");
    });

    test("inserts a <style> before </head> when there is no placeholder", () => {
      const shell = "<html><head><title>x</title></head><body></body></html>";
      expect(injectThemeCss(shell, ".a{}")).toContain(
        "<style>.a{}</style></head>",
      );
    });

    test("falls back to before </body> when there is no </head>", () => {
      const shell = "<html><body><p>x</p></body></html>";
      expect(injectThemeCss(shell, ".a{}")).toContain(
        "<style>.a{}</style></body>",
      );
    });

    test("appends when there is neither </head> nor </body>", () => {
      expect(injectThemeCss("<p>x</p>", ".a{}")).toBe(
        "<p>x</p><style>.a{}</style>",
      );
    });

    test("returns the shell verbatim when theme is empty and no placeholder", () => {
      const shell = "<html><head></head><body></body></html>";
      expect(injectThemeCss(shell, "")).toBe(shell);
    });

    test("inserts $-sequences in the theme literally", () => {
      const shell = "<head></head>";
      // `$&`/`$1` must NOT be interpreted as replacement patterns.
      expect(injectThemeCss(shell, '.a::before{content:"$& $1"}')).toContain(
        'content:"$& $1"',
      );
    });
  });

  describe("resolveMcpAppHtml with a configured theme", () => {
    const original = config.server.web.theme;
    beforeEach(() => {
      config.server.web.theme = themeFixture;
      resetThemeCache();
    });
    afterEach(() => {
      config.server.web.theme = original;
      resetThemeCache();
    });

    test("injects the theme into the default shell placeholder", async () => {
      const html = await resolveMcpAppHtml({ client: fixture });
      expect(html).toContain("--keryx-color-primary: #00ccff");
      expect(html).not.toContain("/* MCP_APP_THEME */");
      // Client bundle is still inlined alongside the theme.
      expect(html).toContain("MCP_APP_FIXTURE_MARKER");
    });

    test("injects the theme into an html-only shell", async () => {
      const html = await resolveMcpAppHtml({
        html: "<html><head></head><body>hi</body></html>",
      });
      expect(html).toContain("<style>");
      expect(html).toContain("--keryx-color-primary: #00ccff");
    });
  });

  describe("resolveMcpAppHtml with no theme configured", () => {
    beforeEach(() => resetThemeCache());
    afterEach(() => resetThemeCache());

    test("returns an html-only shell byte-for-byte verbatim", async () => {
      expect(await resolveMcpAppHtml({ html: "<p>hi</p>" })).toBe("<p>hi</p>");
    });
  });
});
