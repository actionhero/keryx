import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Action } from "../../classes/Action";
import { config } from "../../config";
import {
  type AuthPageParams,
  loadOAuthTemplates,
  type OAuthTemplates,
  renderAuthPage,
} from "../../util/oauthTemplates";
import { resetThemeCache } from "../../util/theme";

const packageDir = import.meta.dir + "/../..";
const themeFixture = import.meta.dir + "/../fixtures/theme.ts";

// Minimal login action so renderAuthPage emits the sign-in form (and thus the
// hidden fields that reflect the OAuth params we want to assert are escaped).
const loginAction = {
  name: "session:create",
  inputs: z.object({ email: z.string(), password: z.string() }),
} as unknown as Action;
const actions = { loginAction };

const baseParams = (overrides: Partial<AuthPageParams>): AuthPageParams => ({
  clientId: "client-1",
  redirectUri: "https://example.com/callback",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  responseType: "code",
  state: "",
  error: "",
  ...overrides,
});

describe("renderAuthPage", () => {
  let templates: OAuthTemplates;

  beforeAll(async () => {
    templates = await loadOAuthTemplates(packageDir, packageDir);
  });

  test("HTML-escapes reflected OAuth params (redirect_uri, state)", async () => {
    const malicious = 'https://evil.com/cb"><script>alert(1)</script>';
    const response = renderAuthPage(
      baseParams({ redirectUri: malicious, state: malicious }),
      templates,
      actions,
    );
    const html = await response.text();

    // The raw unescaped payload must NOT appear in the output
    expect(html).not.toContain("<script>alert(1)</script>");
    // Angle brackets must be entity-encoded
    expect(html).toContain("&lt;script&gt;");
  });

  test("HTML-escapes the error message", async () => {
    const response = renderAuthPage(
      baseParams({ error: '<img src=x onerror="alert(1)">' }),
      templates,
      actions,
    );
    const html = await response.text();

    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img");
  });

  test("renders the hidden OAuth fields", async () => {
    const response = renderAuthPage(
      baseParams({ clientId: "abc123", state: "xyz" }),
      templates,
      actions,
    );
    const html = await response.text();

    expect(html).toContain('name="client_id"');
    expect(html).toContain("abc123");
    expect(html).toContain('name="redirect_uri"');
  });

  test("omits theme CSS when no theme is configured", () => {
    expect(templates.themeCss).toBe("");
  });

  test("inlines the shared default theme tokens even with no user theme", async () => {
    const response = renderAuthPage(baseParams({}), templates, actions);
    const html = await response.text();
    // The shared DEFAULT_THEME_CSS tokens are present as the baseline...
    expect(html).toContain("--keryx-color-primary: #2f5266");
    // ...and appear before the styles that consume them.
    expect(html.indexOf("--keryx-color-primary: #2f5266")).toBeLessThan(
      html.indexOf(".container"),
    );
  });
});

describe("loadOAuthTemplates theming", () => {
  const original = config.server.web.theme;
  afterEach(() => {
    config.server.web.theme = original;
    resetThemeCache();
  });

  test("inlines the configured theme after the common CSS", async () => {
    config.server.web.theme = themeFixture;
    resetThemeCache();
    const templates = await loadOAuthTemplates(packageDir, packageDir);
    expect(templates.themeCss).toContain("--keryx-color-primary: #00ccff");

    const response = renderAuthPage(baseParams({}), templates, actions);
    const html = await response.text();
    // Theme CSS is present, and appears after the shipped common CSS so its
    // :root overrides win by cascade order.
    expect(html).toContain("--keryx-color-primary: #00ccff");
    expect(html.indexOf("--keryx-color-primary: #00ccff")).toBeGreaterThan(
      html.indexOf(".container"),
    );
  });
});
