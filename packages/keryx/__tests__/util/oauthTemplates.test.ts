import { beforeAll, describe, expect, test } from "bun:test";
import {
  loadOAuthTemplates,
  type OAuthTemplates,
  renderSuccessPage,
} from "../../util/oauthTemplates";

const packageDir = import.meta.dir + "/../..";

describe("renderSuccessPage", () => {
  let templates: OAuthTemplates;

  beforeAll(async () => {
    templates = await loadOAuthTemplates(packageDir, packageDir);
  });

  test("HTML-escapes the redirectUrl in the meta tag", async () => {
    const malicious =
      'https://evil.com/callback?a=1"><script>alert(1)</script>';
    const response = renderSuccessPage(malicious, templates);
    const html = await response.text();

    // The raw string with unescaped <script> must NOT appear in the output
    expect(html).not.toContain("<script>alert(1)</script>");
    // Angle brackets must be entity-encoded
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders a safe URL with HTML entity encoding", async () => {
    const safeUrl = "https://example.com/callback?code=abc&state=xyz";
    const response = renderSuccessPage(safeUrl, templates);
    const html = await response.text();

    // The & in query params gets entity-encoded by Mustache
    expect(html).toContain("?code&#x3D;abc&amp;state&#x3D;xyz");
  });
});
