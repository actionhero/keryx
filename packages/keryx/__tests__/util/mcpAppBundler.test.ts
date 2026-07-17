import { describe, expect, test } from "bun:test";
import {
  bundleMcpAppClient,
  DEFAULT_MCP_APP_SHELL,
  resolveMcpAppHtml,
} from "../../util/mcpAppBundler";

const fixture = new URL("../fixtures/mcpAppClient.ts", import.meta.url);
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
      ).rejects.toThrow(/Failed to bundle MCP App client/);
    });
  });
});
