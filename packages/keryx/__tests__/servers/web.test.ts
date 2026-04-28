import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Status } from "../../actions/status";
import { type ActionResponse, api, config } from "../../api";
import { type Action, HTTP_METHOD } from "../../classes/Action";
import { useTestServer } from "./../setup";

const getUrl = useTestServer();

const staticDir = config.server.web.staticFiles.directory;

beforeAll(() => {
  // Ensure the static assets directory exists with test files
  if (!existsSync(staticDir)) mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "test.txt"), "hello static");

  // Create a root index.html for root fallback test
  writeFileSync(path.join(staticDir, "index.html"), "<h1>root index</h1>");

  // Create a subdirectory with an index.html for directory fallback tests
  const subDir = path.join(staticDir, "subdir");
  if (!existsSync(subDir)) mkdirSync(subDir, { recursive: true });
  writeFileSync(path.join(subDir, "index.html"), "<h1>subdir index</h1>");
});

afterAll(() => {
  // Clean up test files
  rmSync(path.join(staticDir, "test.txt"), { force: true });
  rmSync(path.join(staticDir, "index.html"), { force: true });
  rmSync(path.join(staticDir, "subdir"), { recursive: true, force: true });
});

describe("booting", () => {
  test("the web server will boot on a test port", async () => {
    expect(getUrl()).toMatch(/^http:\/\/localhost:\d+$/);
  });
});

describe("actions", () => {
  test("the web server can handle a request to an action", async () => {
    const res = await fetch(getUrl() + "/api/status");
    expect(res.status).toBe(200);
    const response = (await res.json()) as ActionResponse<Status>;
    expect(response.name).toInclude("test-server");
  });

  test("trying for a non-existent action returns a 404", async () => {
    const res = await fetch(getUrl() + "/api/non-existent-action");
    expect(res.status).toBe(404);
    const response = (await res.json()) as ActionResponse<Status>;
    expect(response.error?.message).toContain("Action not found");
    expect(response.error?.stack).toContain("/keryx/");
  });

  test("error responses omit stack when includeStackInErrors is false", async () => {
    const original = config.server.web.includeStackInErrors;
    config.server.web.includeStackInErrors = false;
    try {
      const res = await fetch(getUrl() + "/api/non-existent-action");
      expect(res.status).toBe(404);
      const response = (await res.json()) as ActionResponse<Status>;
      expect(response.error?.message).toContain("Action not found");
      expect(response.error?.stack).toBeUndefined();
    } finally {
      config.server.web.includeStackInErrors = original;
    }
  });
});

describe("body size limit", () => {
  test("returns 413 when Content-Length exceeds maxBodySize", async () => {
    const original = config.server.web.maxBodySize;
    config.server.web.maxBodySize = 100;
    try {
      const body = JSON.stringify({ data: "x".repeat(200) });
      const res = await fetch(getUrl() + "/api/status", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
        },
        body,
      });
      expect(res.status).toBe(413);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toContain("Payload Too Large");
    } finally {
      config.server.web.maxBodySize = original;
    }
  });

  test("allows requests within the body size limit", async () => {
    const original = config.server.web.maxBodySize;
    config.server.web.maxBodySize = 10_000;
    try {
      const res = await fetch(getUrl() + "/api/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });
      // status action doesn't have a POST route, so 404 is expected —
      // the important thing is it was NOT rejected with 413
      expect(res.status).not.toBe(413);
    } finally {
      config.server.web.maxBodySize = original;
    }
  });
});

describe("security headers", () => {
  test("API responses include security headers", async () => {
    const res = await fetch(getUrl() + "/api/status");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: blob:; connect-src 'self'; worker-src blob:",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  test("static file responses include security headers", async () => {
    const res = await fetch(getUrl() + "/test.txt");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: blob:; connect-src 'self'; worker-src blob:",
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });
});

describe("CORS headers", () => {
  test("wildcard allowedOrigins without Origin header returns * and no credentials", async () => {
    const original = config.server.web.allowedOrigins;
    (config.server.web as any).allowedOrigins = "*";
    try {
      const res = await fetch(getUrl() + "/api/status");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    } finally {
      (config.server.web as any).allowedOrigins = original;
    }
  });

  test("wildcard allowedOrigins with Origin header reflects origin and sets credentials", async () => {
    const original = config.server.web.allowedOrigins;
    (config.server.web as any).allowedOrigins = "*";
    try {
      const res = await fetch(getUrl() + "/api/status", {
        headers: { Origin: "http://example.com" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://example.com",
      );
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(res.headers.get("Vary")).toContain("Origin");
    } finally {
      (config.server.web as any).allowedOrigins = original;
    }
  });

  test("specific allowedOrigins with matching Origin reflects origin and sets credentials", async () => {
    const original = config.server.web.allowedOrigins;
    (config.server.web as any).allowedOrigins = "http://allowed.example.com";
    try {
      const res = await fetch(getUrl() + "/api/status", {
        headers: { Origin: "http://allowed.example.com" },
      });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://allowed.example.com",
      );
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(res.headers.get("Vary")).toContain("Origin");
    } finally {
      (config.server.web as any).allowedOrigins = original;
    }
  });

  test("specific allowedOrigins with non-matching Origin omits credentials", async () => {
    const original = config.server.web.allowedOrigins;
    (config.server.web as any).allowedOrigins = "http://allowed.example.com";
    try {
      const res = await fetch(getUrl() + "/api/status", {
        headers: { Origin: "http://evil.example.com" },
      });
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    } finally {
      (config.server.web as any).allowedOrigins = original;
    }
  });

  test("OPTIONS preflight with Origin reflects origin", async () => {
    const original = config.server.web.allowedOrigins;
    const url = getUrl();
    (config.server.web as any).allowedOrigins = url;
    try {
      const res = await fetch(url + "/api/status", {
        method: "OPTIONS",
        headers: { Origin: url },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(url);
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    } finally {
      (config.server.web as any).allowedOrigins = original;
    }
  });
});

describe("cookies", () => {
  test("session cookie uses SameSite=Strict", async () => {
    const res = await fetch(getUrl() + "/api/status");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("SameSite=Strict");
  });

  test("session cookie includes HttpOnly", async () => {
    const res = await fetch(getUrl() + "/api/status");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
  });

  test("session cookie includes expected name", async () => {
    const res = await fetch(getUrl() + "/api/status");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${config.session.cookieName}=`);
  });
});

describe("correlation IDs", () => {
  test("no X-Request-Id header by default (trustProxy is false)", async () => {
    const res = await fetch(getUrl() + "/api/status");
    expect(res.headers.get("X-Request-Id")).toBeNull();
  });

  test("echoes incoming X-Request-Id when trustProxy is true", async () => {
    const original = config.server.web.correlationId.trustProxy;
    (config.server.web.correlationId as any).trustProxy = true;
    try {
      const incomingId = crypto.randomUUID();
      const res = await fetch(getUrl() + "/api/status", {
        headers: { "X-Request-Id": incomingId },
      });
      expect(res.headers.get("X-Request-Id")).toBe(incomingId);
    } finally {
      (config.server.web.correlationId as any).trustProxy = original;
    }
  });

  test("no X-Request-Id when trustProxy is true but no header sent", async () => {
    const original = config.server.web.correlationId.trustProxy;
    (config.server.web.correlationId as any).trustProxy = true;
    try {
      const res = await fetch(getUrl() + "/api/status");
      expect(res.headers.get("X-Request-Id")).toBeNull();
    } finally {
      (config.server.web.correlationId as any).trustProxy = original;
    }
  });

  test("no X-Request-Id header when correlationId.header is empty", async () => {
    const originalHeader = config.server.web.correlationId.header;
    const originalTrust = config.server.web.correlationId.trustProxy;
    (config.server.web.correlationId as any).header = "";
    (config.server.web.correlationId as any).trustProxy = true;
    try {
      const res = await fetch(getUrl() + "/api/status", {
        headers: { "X-Request-Id": crypto.randomUUID() },
      });
      expect(res.headers.get("X-Request-Id")).toBeNull();
    } finally {
      (config.server.web.correlationId as any).header = originalHeader;
      (config.server.web.correlationId as any).trustProxy = originalTrust;
    }
  });

  test("error responses also echo X-Request-Id when trustProxy is true", async () => {
    const original = config.server.web.correlationId.trustProxy;
    (config.server.web.correlationId as any).trustProxy = true;
    try {
      const incomingId = crypto.randomUUID();
      const res = await fetch(getUrl() + "/api/non-existent-action", {
        headers: { "X-Request-Id": incomingId },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("X-Request-Id")).toBe(incomingId);
    } finally {
      (config.server.web.correlationId as any).trustProxy = original;
    }
  });
});

describe("static files", () => {
  test("serves a file from the static directory", async () => {
    const res = await fetch(getUrl() + "/test.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello static");
  });

  // Path traversal rejection tests live in __tests__/util/webStaticFiles.test.ts.
  // Traversal sequences like `../` and `%2e%2e` are normalized by the WHATWG
  // URL parser (and Bun.serve) before reaching the handler, so testing requires
  // raw HTTP sockets — see that file.

  test("includes ETag and Last-Modified headers", async () => {
    const res = await fetch(getUrl() + "/test.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^".+"$/);
    expect(res.headers.get("last-modified")).toBeTruthy();
  });

  test("includes Cache-Control header", async () => {
    const res = await fetch(getUrl() + "/test.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("returns 304 for matching If-None-Match", async () => {
    const res1 = await fetch(getUrl() + "/test.txt");
    const etag = res1.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const res2 = await fetch(getUrl() + "/test.txt", {
      headers: { "If-None-Match": etag },
    });
    expect(res2.status).toBe(304);
  });

  test("returns 200 for non-matching If-None-Match", async () => {
    const res = await fetch(getUrl() + "/test.txt", {
      headers: { "If-None-Match": '"bogus"' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello static");
  });

  test("returns 304 for If-Modified-Since when file is not newer", async () => {
    const res1 = await fetch(getUrl() + "/test.txt");
    const lastModified = res1.headers.get("last-modified")!;
    expect(lastModified).toBeTruthy();

    const res2 = await fetch(getUrl() + "/test.txt", {
      headers: { "If-Modified-Since": lastModified },
    });
    expect(res2.status).toBe(304);
  });

  test("returns 200 for If-Modified-Since in the distant past", async () => {
    const res = await fetch(getUrl() + "/test.txt", {
      headers: { "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello static");
  });

  test("omits ETag when staticFiles.etag is disabled", async () => {
    const original = config.server.web.staticFiles.etag;
    (config.server.web.staticFiles as any).etag = false;
    try {
      const res = await fetch(getUrl() + "/test.txt");
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBeNull();
      expect(res.headers.get("last-modified")).toBeNull();
    } finally {
      (config.server.web.staticFiles as any).etag = original;
    }
  });

  test("serves index.html for root static route", async () => {
    const staticRoute = config.server.web.staticFiles.route;
    const res = await fetch(getUrl() + staticRoute);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("root index");
  });

  test("serves index.html for subdirectory path", async () => {
    const res = await fetch(getUrl() + "/subdir/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("subdir index");
  });

  test("serves index.html for subdirectory path without trailing slash", async () => {
    const res = await fetch(getUrl() + "/subdir");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("subdir index");
  });
});

describe("rate limit response headers", () => {
  test("includes rate limit headers when connection has rateLimitInfo", async () => {
    const { buildHeaders } = await import("../../util/webResponse");
    const { Connection } = await import("../../classes/Connection");
    const connection = new Connection("test", "10.0.0.1");
    connection.rateLimitInfo = {
      limit: 100,
      remaining: 95,
      resetAt: 1700000000,
    };
    const headers = buildHeaders(connection);
    expect(headers["X-RateLimit-Limit"]).toBe("100");
    expect(headers["X-RateLimit-Remaining"]).toBe("95");
    expect(headers["X-RateLimit-Reset"]).toBe("1700000000");
    expect(headers["Retry-After"]).toBeUndefined();
    connection.destroy();
  });

  test("includes Retry-After header when retryAfter is present", async () => {
    const { buildHeaders } = await import("../../util/webResponse");
    const { Connection } = await import("../../classes/Connection");
    const connection = new Connection("test", "10.0.0.1");
    connection.rateLimitInfo = {
      limit: 100,
      remaining: 0,
      resetAt: 1700000000,
      retryAfter: 30,
    };
    const headers = buildHeaders(connection);
    expect(headers["X-RateLimit-Limit"]).toBe("100");
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(headers["Retry-After"]).toBe("30");
    connection.destroy();
  });

  test("omits rate limit headers when rateLimitInfo is not set", async () => {
    const { buildHeaders } = await import("../../util/webResponse");
    const { Connection } = await import("../../classes/Connection");
    const connection = new Connection("test", "10.0.0.1");
    const headers = buildHeaders(connection);
    expect(headers["X-RateLimit-Limit"]).toBeUndefined();
    expect(headers["X-RateLimit-Remaining"]).toBeUndefined();
    expect(headers["X-RateLimit-Reset"]).toBeUndefined();
    expect(headers["Retry-After"]).toBeUndefined();
    connection.destroy();
  });
});

describe("raw Response passthrough", () => {
  beforeAll(() => {
    const rawAction = {
      name: "test:rawResponse",
      inputs: z.object({}),
      web: { route: "/test/raw-response", method: HTTP_METHOD.GET },
      run: async () =>
        new Response("raw binary data", {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
    } as unknown as Action;

    const rawAction201 = {
      name: "test:rawResponse201",
      inputs: z.object({}),
      web: { route: "/test/raw-response-201", method: HTTP_METHOD.POST },
      run: async () =>
        new Response(JSON.stringify({ created: true }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    } as unknown as Action;

    const rawAction204 = {
      name: "test:rawResponse204",
      inputs: z.object({}),
      web: { route: "/test/raw-response-204", method: HTTP_METHOD.DELETE },
      run: async () => new Response(null, { status: 204 }),
    } as unknown as Action;

    api.actions.actions.push(rawAction, rawAction201, rawAction204);
  });

  test("returns the raw Response body and Content-Type", async () => {
    const res = await fetch(getUrl() + "/api/test/raw-response");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("raw binary data");
  });

  test("does not include Keryx standard headers", async () => {
    const res = await fetch(getUrl() + "/api/test/raw-response");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("X-SERVER-NAME")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  test("preserves custom status codes", async () => {
    const res = await fetch(getUrl() + "/api/test/raw-response-201", {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: boolean };
    expect(body.created).toBe(true);
  });

  test("handles empty body with 204 status", async () => {
    const res = await fetch(getUrl() + "/api/test/raw-response-204", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});

describe("compression", () => {
  // The /api/swagger endpoint returns a large OpenAPI spec (well above 1024 bytes)
  test("returns gzip-compressed response when Accept-Encoding: gzip", async () => {
    const res = await fetch(getUrl() + "/api/swagger", {
      headers: { "Accept-Encoding": "gzip" },
      decompress: false,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Vary")).toInclude("Accept-Encoding");

    // Decompress and verify valid JSON
    const decompressed = new Response(
      res.body!.pipeThrough(new DecompressionStream("gzip")),
    );
    const body = (await decompressed.json()) as Record<string, unknown>;
    expect(body.openapi).toBeDefined();
  });

  test("returns brotli-compressed response when Accept-Encoding: br", async () => {
    const res = await fetch(getUrl() + "/api/swagger", {
      headers: { "Accept-Encoding": "br" },
      decompress: false,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("br");

    const decompressed = new Response(
      res.body!.pipeThrough(new DecompressionStream("brotli")),
    );
    const body = (await decompressed.json()) as Record<string, unknown>;
    expect(body.openapi).toBeDefined();
  });

  test("prefers brotli over gzip when both are accepted", async () => {
    const res = await fetch(getUrl() + "/api/swagger", {
      headers: { "Accept-Encoding": "gzip, br" },
      decompress: false,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("br");
  });

  test("does not compress when Accept-Encoding is absent", async () => {
    const res = await fetch(getUrl() + "/api/swagger", {
      headers: { "Accept-Encoding": "" },
      decompress: false,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBeNull();
  });

  test("does not compress responses below the threshold", async () => {
    // /api/status returns a small JSON object (~200 bytes), below the 1024 byte threshold
    const res = await fetch(getUrl() + "/api/status", {
      headers: { "Accept-Encoding": "gzip" },
      decompress: false,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBeNull();
  });

  test("does not compress null-body responses", async () => {
    const res = await fetch(getUrl() + "/.well-known/test", {
      headers: { "Accept-Encoding": "gzip" },
      decompress: false,
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Encoding")).toBeNull();
  });

  test("compresses static text files above threshold", async () => {
    const largeContent = "x".repeat(2048);
    writeFileSync(path.join(staticDir, "large.txt"), largeContent);

    try {
      const res = await fetch(getUrl() + "/large.txt", {
        headers: { "Accept-Encoding": "gzip" },
        decompress: false,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Encoding")).toBe("gzip");

      const decompressed = new Response(
        res.body!.pipeThrough(new DecompressionStream("gzip")),
      );
      const text = await decompressed.text();
      expect(text).toBe(largeContent);
    } finally {
      rmSync(path.join(staticDir, "large.txt"), { force: true });
    }
  });
});

describe("request hooks", () => {
  const resetHooks = () => {
    const hooksInitializer = api.initializers.find((i) => i.name === "hooks");
    (hooksInitializer as any).webBeforeRequest.length = 0;
    (hooksInitializer as any).webAfterRequest.length = 0;
  };

  test("beforeRequest fires before the response is produced", async () => {
    resetHooks();
    const seen: Array<{ url: string; metadata: Record<string, unknown> }> = [];
    api.hooks.web.beforeRequest((req, ctx) => {
      seen.push({ url: req.url, metadata: ctx.metadata });
    });

    const res = await fetch(getUrl() + "/api/status");
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
    expect(seen[0].url).toContain("/api/status");
  });

  test("afterRequest receives the final Response", async () => {
    resetHooks();
    const seen: Array<{ status: number }> = [];
    api.hooks.web.afterRequest((_req, res) => {
      seen.push({ status: res.status });
    });

    await fetch(getUrl() + "/api/status");
    expect(seen.length).toBe(1);
    expect(seen[0].status).toBe(200);
  });

  test("ctx.metadata flows from beforeRequest to afterRequest", async () => {
    resetHooks();
    let carried: unknown;
    api.hooks.web.beforeRequest((_req, ctx) => {
      ctx.metadata.marker = "hello";
    });
    api.hooks.web.afterRequest((_req, _res, ctx) => {
      carried = ctx.metadata.marker;
    });

    await fetch(getUrl() + "/api/status");
    expect(carried).toBe("hello");
  });

  test("hooks fire for non-action requests (e.g. 404 paths)", async () => {
    resetHooks();
    let fired = 0;
    api.hooks.web.beforeRequest(() => {
      fired++;
    });
    api.hooks.web.afterRequest(() => {
      fired++;
    });

    const res = await fetch(getUrl() + "/.well-known/does-not-exist");
    expect(res.status).toBe(404);
    expect(fired).toBe(2);
  });

  test("multiple beforeRequest hooks run in registration order", async () => {
    resetHooks();
    const calls: string[] = [];
    api.hooks.web.beforeRequest(() => {
      calls.push("a");
    });
    api.hooks.web.beforeRequest(() => {
      calls.push("b");
    });

    await fetch(getUrl() + "/api/status");
    expect(calls).toEqual(["a", "b"]);
  });
});
