import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../../config";
import {
  appendHeaders,
  buildCorsHeaders,
  getExternalOrigin,
  getMcpAllowedOrigins,
  isOriginAllowed,
} from "../../util/http";

let originalAllowedOrigins: string;
let originalApplicationUrl: string;
let originalOauthTrustProxy: boolean;
let originalMcpAllowedOrigins: string;

beforeAll(() => {
  originalAllowedOrigins = config.server.web.allowedOrigins;
  originalApplicationUrl = config.server.web.applicationUrl;
  originalOauthTrustProxy = config.server.mcp.oauthTrustProxy;
  originalMcpAllowedOrigins = config.server.mcp.allowedOrigins;
});

afterAll(() => {
  config.server.web.allowedOrigins = originalAllowedOrigins;
  config.server.web.applicationUrl = originalApplicationUrl;
  config.server.mcp.oauthTrustProxy = originalOauthTrustProxy;
  config.server.mcp.allowedOrigins = originalMcpAllowedOrigins;
});

describe("isOriginAllowed", () => {
  test("wildcard allows any origin", () => {
    config.server.web.allowedOrigins = "*";
    expect(isOriginAllowed("https://example.com")).toBe(true);
  });

  test("comma-separated list matches exactly", () => {
    config.server.web.allowedOrigins =
      "https://a.com,https://b.com,https://c.com";
    expect(isOriginAllowed("https://b.com")).toBe(true);
  });

  test("non-matching origin rejected", () => {
    config.server.web.allowedOrigins = "https://a.com,https://b.com";
    expect(isOriginAllowed("https://evil.com")).toBe(false);
  });

  test("whitespace in list is trimmed", () => {
    config.server.web.allowedOrigins = " https://a.com , https://b.com ";
    expect(isOriginAllowed("https://b.com")).toBe(true);
  });

  test("extraAllowedOrigins permits an origin not in the web list", () => {
    config.server.web.allowedOrigins = "https://a.com";
    expect(isOriginAllowed("https://claude.ai", ["https://claude.ai"])).toBe(
      true,
    );
    expect(isOriginAllowed("https://evil.com", ["https://claude.ai"])).toBe(
      false,
    );
  });

  test("wildcard short-circuits extraAllowedOrigins", () => {
    config.server.web.allowedOrigins = "*";
    expect(isOriginAllowed("https://anything.com", [])).toBe(true);
  });
});

describe("getMcpAllowedOrigins", () => {
  test("includes the applicationUrl origin and configured origins", () => {
    config.server.web.applicationUrl = "https://myapp.example.com";
    config.server.mcp.allowedOrigins = "https://claude.ai,https://claude.com";
    const origins = getMcpAllowedOrigins();
    expect(origins).toContain("https://myapp.example.com");
    expect(origins).toContain("https://claude.ai");
    expect(origins).toContain("https://claude.com");
  });

  test("trims whitespace and drops empty entries", () => {
    config.server.web.applicationUrl = "https://myapp.example.com";
    config.server.mcp.allowedOrigins = " https://claude.ai , , https://x.com ";
    const origins = getMcpAllowedOrigins();
    expect(origins).toContain("https://claude.ai");
    expect(origins).toContain("https://x.com");
    expect(origins).not.toContain("");
  });
});

describe("buildCorsHeaders", () => {
  test("wildcard with no request origin returns *", () => {
    config.server.web.allowedOrigins = "*";
    const headers = buildCorsHeaders(undefined);
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  test("matching specific origin reflects it with Vary", () => {
    config.server.web.allowedOrigins = "https://app.com";
    const headers = buildCorsHeaders("https://app.com");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.com");
    expect(headers["Vary"]).toBe("Origin");
  });

  test("non-matching origin returns no CORS header", () => {
    config.server.web.allowedOrigins = "https://app.com";
    const headers = buildCorsHeaders("https://evil.com");
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("extra headers are merged", () => {
    config.server.web.allowedOrigins = "*";
    const headers = buildCorsHeaders(undefined, {
      "Access-Control-Allow-Methods": "GET, POST",
    });
    expect(headers["Access-Control-Allow-Methods"]).toBe("GET, POST");
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  test("reflects an origin allowed only via extraAllowedOrigins", () => {
    config.server.web.allowedOrigins = "https://app.com";
    const headers = buildCorsHeaders("https://claude.ai", undefined, [
      "https://claude.ai",
    ]);
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://claude.ai");
    expect(headers["Vary"]).toBe("Origin");
  });
});

describe("getExternalOrigin", () => {
  test("returns applicationUrl origin when set (non-localhost)", () => {
    config.server.web.applicationUrl = "https://myapp.example.com";
    config.server.mcp.oauthTrustProxy = false;
    const req = new Request("http://localhost:3000/test");
    const url = new URL("http://localhost:3000/test");
    expect(getExternalOrigin(req, url)).toBe("https://myapp.example.com");
  });

  test("uses X-Forwarded-Proto + X-Forwarded-Host when trustProxy enabled", () => {
    config.server.web.applicationUrl = "";
    config.server.mcp.oauthTrustProxy = true;
    const req = new Request("http://localhost:3000/test", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "proxy.example.com",
      },
    });
    const url = new URL("http://localhost:3000/test");
    expect(getExternalOrigin(req, url)).toBe("https://proxy.example.com");
  });

  test("uses request protocol with forwarded host when no forwarded proto", () => {
    config.server.web.applicationUrl = "";
    config.server.mcp.oauthTrustProxy = true;
    const req = new Request("http://localhost:3000/test", {
      headers: { "x-forwarded-host": "proxy.example.com" },
    });
    const url = new URL("http://localhost:3000/test");
    expect(getExternalOrigin(req, url)).toBe("http://proxy.example.com");
  });

  test("ignores X-Forwarded-* headers when trustProxy is false (default)", () => {
    config.server.web.applicationUrl = "";
    config.server.mcp.oauthTrustProxy = false;
    const req = new Request("http://localhost:3000/test", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example.com",
      },
    });
    const url = new URL("http://localhost:3000/test");
    expect(getExternalOrigin(req, url)).toBe("http://localhost:3000");
  });

  test("ignores spoofed Host header when trustProxy is false", () => {
    config.server.web.applicationUrl = "";
    config.server.mcp.oauthTrustProxy = false;
    const req = new Request("http://localhost:3000/test", {
      headers: { host: "evil.example.com" },
    });
    const url = new URL("http://localhost:3000/test");
    expect(getExternalOrigin(req, url)).toBe("http://localhost:3000");
  });

  test("falls back to request URL origin", () => {
    config.server.web.applicationUrl = "";
    config.server.mcp.oauthTrustProxy = false;
    const req = new Request("http://localhost:3000/test");
    const url = new URL("http://localhost:3000/test");
    expect(getExternalOrigin(req, url)).toBe("http://localhost:3000");
  });
});

describe("appendHeaders", () => {
  test("merges new headers without overwriting existing ones", () => {
    const original = new Response("ok", {
      headers: { "Content-Type": "text/plain", "X-Existing": "keep" },
    });
    const result = appendHeaders(original, {
      "X-Existing": "overwrite-attempt",
      "X-New": "added",
    });
    expect(result.headers.get("X-Existing")).toBe("keep");
    expect(result.headers.get("X-New")).toBe("added");
    expect(result.headers.get("Content-Type")).toBe("text/plain");
  });

  test("preserves status code", () => {
    const original = new Response("created", { status: 201 });
    const result = appendHeaders(original, { "X-Foo": "bar" });
    expect(result.status).toBe(201);
  });
});
