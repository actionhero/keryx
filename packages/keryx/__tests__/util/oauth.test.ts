import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  base64UrlEncode,
  escapeHtml,
  redirectUrisMatch,
  validateRedirectUri,
} from "../../util/oauth";

describe("validateRedirectUri", () => {
  test("accepts HTTPS URI", () => {
    expect(validateRedirectUri("https://example.com/callback")).toEqual({
      valid: true,
    });
  });

  test("accepts http://localhost", () => {
    expect(validateRedirectUri("http://localhost:3000/callback")).toEqual({
      valid: true,
    });
  });

  test("accepts http://127.0.0.1", () => {
    expect(validateRedirectUri("http://127.0.0.1/cb")).toEqual({ valid: true });
  });

  test("accepts http://[::1]", () => {
    expect(validateRedirectUri("http://[::1]/cb")).toEqual({ valid: true });
  });

  test("rejects non-HTTPS external URI", () => {
    const result = validateRedirectUri("http://example.com/cb");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("HTTPS");
  });

  test("rejects unparseable URI", () => {
    const result = validateRedirectUri("not-a-url");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid URI");
  });

  test("rejects URI with fragment", () => {
    const result = validateRedirectUri("https://example.com/cb#fragment");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("fragment");
  });

  test("rejects URI with userinfo", () => {
    const result = validateRedirectUri("https://user:pass@example.com/cb");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("userinfo");
  });
});

describe("redirectUrisMatch", () => {
  test("exact match returns true", () => {
    expect(
      redirectUrisMatch("https://example.com/cb", "https://example.com/cb"),
    ).toBe(true);
  });

  test("appended query param returns false (RFC 6749 §3.1.2.3)", () => {
    expect(
      redirectUrisMatch(
        "https://example.com/cb",
        "https://example.com/cb?state=xyz",
      ),
    ).toBe(false);
  });

  test("matching query params return true", () => {
    expect(
      redirectUrisMatch(
        "https://example.com/cb?foo=bar",
        "https://example.com/cb?foo=bar",
      ),
    ).toBe(true);
  });

  test("different query param values return false", () => {
    expect(
      redirectUrisMatch(
        "https://example.com/cb?foo=bar",
        "https://example.com/cb?foo=baz",
      ),
    ).toBe(false);
  });

  test("different pathname returns false", () => {
    expect(
      redirectUrisMatch("https://example.com/cb", "https://example.com/other"),
    ).toBe(false);
  });

  test("different origin returns false", () => {
    expect(
      redirectUrisMatch("https://example.com/cb", "https://evil.com/cb"),
    ).toBe(false);
  });

  test("different port returns false", () => {
    expect(
      redirectUrisMatch("http://localhost:3000/cb", "http://localhost:4000/cb"),
    ).toBe(false);
  });
});

describe("base64UrlEncode", () => {
  test("produces URL-safe output with no padding", () => {
    // Bytes chosen so raw base64 contains both '+' and '/' and requires padding
    const input = new Uint8Array([0xfb, 0xff, 0xbf, 0xff]);
    const encoded = base64UrlEncode(input);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  test("empty input returns empty string", () => {
    expect(base64UrlEncode(new Uint8Array())).toBe("");
  });

  test("matches PKCE S256 challenge derived from SHA-256(verifier)", () => {
    // SHA-256 of "test-verifier" base64url-encoded
    const verifier = "test-verifier";
    const digest = createHash("sha256").update(verifier).digest();
    const expected = Buffer.from(digest)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(base64UrlEncode(new Uint8Array(digest))).toBe(expected);
  });

  test("round-trips known bytes", () => {
    const input = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    expect(base64UrlEncode(input)).toBe("aGVsbG8");
  });
});

describe("escapeHtml", () => {
  test("encodes all dangerous characters", () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#039;");
  });

  test("plain text passes through", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  test("neutralizes script tags", () => {
    const malicious = '<script>alert("xss")</script>';
    const escaped = escapeHtml(malicious);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
  });

  test("preserves already-escaped entities as literal text", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});
