import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "../../api";
import { CONNECTION_TYPE, Connection } from "../../classes/Connection";
import { StreamingResponse } from "../../classes/StreamingResponse";
import { ErrorType, TypedError } from "../../classes/TypedError";
import { config } from "../../config";
import {
  buildError,
  buildErrorPayload,
  buildHeaders,
  buildResponse,
  EOL,
  getSecurityHeaders,
} from "../../util/webResponse";
import { HOOK_TIMEOUT } from "../setup";

const originalSessionSecure = config.session.cookieSecure;
const originalIncludeStack = config.server.web.includeStackInErrors;
const originalCSP =
  config.server.web.securityHeaders["Content-Security-Policy"];

beforeAll(async () => {
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  (config.session as any).cookieSecure = originalSessionSecure;
  (config.server.web as any).includeStackInErrors = originalIncludeStack;
  config.server.web.securityHeaders["Content-Security-Policy"] = originalCSP;
  await api.stop();
}, HOOK_TIMEOUT);

describe("getSecurityHeaders", () => {
  test("returns the documented security headers", () => {
    const headers = getSecurityHeaders();
    expect(headers["Content-Security-Policy"]).toBeDefined();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Strict-Transport-Security"]).toContain("max-age=");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("filters out headers set to empty string in config", () => {
    config.server.web.securityHeaders["Content-Security-Policy"] = "";
    try {
      const headers = getSecurityHeaders();
      expect(headers["Content-Security-Policy"]).toBeUndefined();
      // Other headers still present
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    } finally {
      config.server.web.securityHeaders["Content-Security-Policy"] =
        originalCSP;
    }
  });
});

describe("buildHeaders", () => {
  test("without a connection: no cookie or rate-limit headers", () => {
    const headers = buildHeaders(undefined);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-SERVER-NAME"]).toBe(config.process.name);
    expect(headers["Set-Cookie"]).toBeUndefined();
    expect(headers["X-RateLimit-Limit"]).toBeUndefined();
  });

  test("with a connection: Set-Cookie contains session flags", () => {
    const conn = new Connection(CONNECTION_TYPE.WEB, "1.2.3.4");
    try {
      const headers = buildHeaders(conn);
      const cookie = headers["Set-Cookie"];
      expect(cookie).toContain(`${config.session.cookieName}=${conn.id}`);
      expect(cookie).toContain(`Max-Age=${config.session.ttl}`);
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain(`SameSite=${config.session.cookieSameSite}`);
    } finally {
      conn.destroy();
    }
  });

  test("cookieSecure=true emits the Secure flag", () => {
    (config.session as any).cookieSecure = true;
    const conn = new Connection(CONNECTION_TYPE.WEB, "1.2.3.4");
    try {
      const cookie = buildHeaders(conn)["Set-Cookie"];
      expect(cookie).toContain("Secure");
    } finally {
      (config.session as any).cookieSecure = originalSessionSecure;
      conn.destroy();
    }
  });

  test("populates rate-limit headers when info is present", () => {
    const conn = new Connection(CONNECTION_TYPE.WEB, "1.2.3.4");
    conn.rateLimitInfo = {
      limit: 100,
      remaining: 42,
      resetAt: 123456,
      retryAfter: 7,
    };
    try {
      const headers = buildHeaders(conn);
      expect(headers["X-RateLimit-Limit"]).toBe("100");
      expect(headers["X-RateLimit-Remaining"]).toBe("42");
      expect(headers["X-RateLimit-Reset"]).toBe("123456");
      expect(headers["Retry-After"]).toBe("7");
    } finally {
      conn.destroy();
    }
  });

  test("omits Retry-After when retryAfter is undefined", () => {
    const conn = new Connection(CONNECTION_TYPE.WEB, "1.2.3.4");
    conn.rateLimitInfo = {
      limit: 100,
      remaining: 99,
      resetAt: 123456,
    };
    try {
      const headers = buildHeaders(conn);
      expect(headers["Retry-After"]).toBeUndefined();
      expect(headers["X-RateLimit-Remaining"]).toBe("99");
    } finally {
      conn.destroy();
    }
  });

  test("emits correlation ID header when connection carries one", () => {
    const conn = new Connection(CONNECTION_TYPE.WEB, "1.2.3.4");
    conn.correlationId = "corr-xyz-123";
    try {
      const headers = buildHeaders(conn);
      expect(headers[config.server.web.correlationId.header]).toBe(
        "corr-xyz-123",
      );
    } finally {
      conn.destroy();
    }
  });

  test("reflects allowed origin and sets Allow-Credentials", () => {
    // Use an origin that is in the configured allowedOrigins list
    const allowed = config.server.web.allowedOrigins.split(",")[0].trim();
    // Skip if allowedOrigins is wildcard (no specific origin to reflect)
    if (allowed === "*") return;

    const headers = buildHeaders(undefined, allowed);
    expect(headers["Access-Control-Allow-Origin"]).toBe(allowed);
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(headers["Vary"]).toBe("Origin");
  });

  test("rejects origin not in the allowed list", () => {
    if (config.server.web.allowedOrigins === "*") return;
    const headers = buildHeaders(undefined, "https://evil.example.com");
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });
});

describe("buildResponse", () => {
  test("serializes an object to pretty JSON with CRLF terminator", async () => {
    const conn = new Connection(CONNECTION_TYPE.WEB, "1.2.3.4");
    try {
      const res = buildResponse(conn, { hello: "world" });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      const body = await res.text();
      expect(body).toBe(JSON.stringify({ hello: "world" }, null, 2) + EOL);
    } finally {
      conn.destroy();
    }
  });

  test("uses explicit status code when provided", async () => {
    const conn = new Connection(CONNECTION_TYPE.WEB, "1.2.3.4");
    try {
      const res = buildResponse(conn, { ok: true }, 201);
      expect(res.status).toBe(201);
    } finally {
      conn.destroy();
    }
  });

  test("passes a bare Response through unchanged", () => {
    const conn = new Connection(CONNECTION_TYPE.WEB, "1.2.3.4");
    try {
      const passthrough = new Response("raw", { status: 418 });
      const res = buildResponse(conn, passthrough);
      expect(res).toBe(passthrough);
    } finally {
      conn.destroy();
    }
  });

  test("converts a StreamingResponse via .toResponse", async () => {
    const conn = new Connection(CONNECTION_TYPE.WEB, "1.2.3.4");
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed-body"));
          controller.close();
        },
      });
      const sr = StreamingResponse.stream(stream, {
        contentType: "text/plain",
      });

      const res = buildResponse(conn, sr);
      expect(res.headers.get("Content-Type")).toBe("text/plain");
      // Session cookie from buildHeaders should still be present
      expect(res.headers.get("Set-Cookie")).toContain(
        config.session.cookieName,
      );
      expect(await res.text()).toBe("streamed-body");
    } finally {
      conn.destroy();
    }
  });
});

describe("buildErrorPayload", () => {
  test("includes message, type, and timestamp", () => {
    const err = new TypedError({
      message: "boom",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
    const payload = buildErrorPayload(err);

    expect(payload.message).toBe("boom");
    expect(payload.type).toBe(ErrorType.CONNECTION_ACTION_RUN);
    expect(payload.timestamp).toBeGreaterThan(0);
    expect(Math.abs(payload.timestamp - Date.now())).toBeLessThan(5000);
  });

  test("omits key and value when undefined on the error", () => {
    const err = new TypedError({
      message: "boom",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
    const payload = buildErrorPayload(err);

    expect(payload.key).toBeUndefined();
    expect(payload.value).toBeUndefined();
  });

  test("propagates key and value when present", () => {
    const err = new TypedError({
      message: "bad input",
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "email",
      value: "not-an-email",
    });
    const payload = buildErrorPayload(err);

    expect(payload.key).toBe("email");
    expect(payload.value).toBe("not-an-email");
  });

  test("includes stack only when includeStackInErrors is enabled", () => {
    const err = new TypedError({
      message: "boom",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });

    (config.server.web as any).includeStackInErrors = true;
    try {
      const payload = buildErrorPayload(err) as Record<string, unknown>;
      expect(payload.stack).toBeDefined();
      expect(typeof payload.stack).toBe("string");
    } finally {
      (config.server.web as any).includeStackInErrors = originalIncludeStack;
    }

    (config.server.web as any).includeStackInErrors = false;
    try {
      const payload = buildErrorPayload(err) as Record<string, unknown>;
      expect(payload.stack).toBeUndefined();
    } finally {
      (config.server.web as any).includeStackInErrors = originalIncludeStack;
    }
  });
});

describe("buildError", () => {
  test("wraps payload under { error } with the given status", async () => {
    const err = new TypedError({
      message: "not allowed",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
    const res = buildError(undefined, err, 403);

    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Type")).toBe("application/json");

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("not allowed");
  });

  test("defaults to status 500", () => {
    const err = new TypedError({
      message: "internal",
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
    expect(buildError(undefined, err).status).toBe(500);
  });

  test("still includes session cookie when a connection is passed", () => {
    const conn = new Connection(CONNECTION_TYPE.WEB, "1.2.3.4");
    try {
      const err = new TypedError({
        message: "boom",
        type: ErrorType.CONNECTION_ACTION_RUN,
      });
      const res = buildError(conn, err, 500);
      expect(res.headers.get("Set-Cookie")).toContain(
        config.session.cookieName,
      );
    } finally {
      conn.destroy();
    }
  });
});
