import { afterAll, describe, expect, test } from "bun:test";
import { config } from "../../config";
import { compressResponse } from "../../util/webCompression";

const originalThreshold = config.server.web.compression.threshold;
const originalEnabled = config.server.web.compression.enabled;
const originalEncodings = config.server.web.compression.encodings;

afterAll(() => {
  (config.server.web.compression as any).threshold = originalThreshold;
  (config.server.web.compression as any).enabled = originalEnabled;
  (config.server.web.compression as any).encodings = originalEncodings;
});

/** Build an HTTP request carrying the given Accept-Encoding header. */
function reqWith(acceptEncoding: string | null): Request {
  const headers = new Headers();
  if (acceptEncoding !== null) headers.set("Accept-Encoding", acceptEncoding);
  return new Request("http://localhost/", { headers });
}

/** Payload large enough to clear the default 1024-byte threshold. */
const LARGE_BODY = "abc".repeat(1024); // 3072 chars — compresses to well under threshold
const SMALL_BODY = "x".repeat(100);

describe("compressResponse", () => {
  test("returns original when compression is disabled", async () => {
    (config.server.web.compression as any).enabled = false;
    try {
      const res = new Response(LARGE_BODY, {
        headers: { "Content-Type": "text/plain" },
      });
      const out = await compressResponse(res, reqWith("gzip, br"));
      expect(out).toBe(res);
    } finally {
      (config.server.web.compression as any).enabled = originalEnabled;
    }
  });

  test("returns original when response has no body", async () => {
    const res = new Response(null, { status: 204 });
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out).toBe(res);
  });

  test("returns original for SSE text/event-stream", async () => {
    const res = new Response("data: hello\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out).toBe(res);
  });

  test("returns original when Content-Encoding is already set", async () => {
    const res = new Response(LARGE_BODY, {
      headers: {
        "Content-Type": "text/plain",
        "Content-Encoding": "gzip",
      },
    });
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out).toBe(res);
  });

  test("returns original when Accept-Encoding header is missing", async () => {
    const res = new Response(LARGE_BODY, {
      headers: { "Content-Type": "text/plain" },
    });
    const out = await compressResponse(res, reqWith(null));
    expect(out).toBe(res);
  });

  test("returns original when client supports no matching encoding", async () => {
    const res = new Response(LARGE_BODY, {
      headers: { "Content-Type": "text/plain" },
    });
    const out = await compressResponse(res, reqWith("identity, deflate"));
    expect(out).toBe(res);
  });

  test.each([
    "image/png",
    "image/jpeg",
    "video/mp4",
    "application/zip",
    "application/wasm",
  ])("returns original for incompressible content-type %s", async (type) => {
    const res = new Response(LARGE_BODY, {
      headers: {
        "Content-Type": type,
        "Content-Length": String(LARGE_BODY.length),
      },
    });
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.headers.get("Content-Encoding")).toBeNull();
  });

  test("Content-Type with charset is still matched as incompressible", async () => {
    const res = new Response(LARGE_BODY, {
      headers: {
        "Content-Type": "image/png; charset=utf-8",
        "Content-Length": String(LARGE_BODY.length),
      },
    });
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.headers.get("Content-Encoding")).toBeNull();
  });

  test("returns original when Content-Length is below threshold", async () => {
    const res = new Response(SMALL_BODY, {
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": String(SMALL_BODY.length),
      },
    });
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.headers.get("Content-Encoding")).toBeNull();
  });

  test("small body without Content-Length is preserved after the threshold read", async () => {
    // No Content-Length — compressResponse buffers the body to check size, then
    // returns a fresh Response with the same bytes.
    const res = new Response(SMALL_BODY, {
      headers: { "Content-Type": "text/plain" },
    });
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.headers.get("Content-Encoding")).toBeNull();
    expect(await out.text()).toBe(SMALL_BODY);
  });

  test("compresses large body with gzip when only gzip is accepted", async () => {
    const res = new Response(LARGE_BODY, {
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": String(LARGE_BODY.length),
      },
    });
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
    expect(out.headers.get("Vary")).toContain("Accept-Encoding");
    expect(out.headers.get("Content-Length")).toBeNull();

    const decompressed = new Response(
      out.body!.pipeThrough(new DecompressionStream("gzip")),
    );
    expect(await decompressed.text()).toBe(LARGE_BODY);
  });

  test("ignores unsupported encodings and uses gzip when offered", async () => {
    const res = new Response(LARGE_BODY, {
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": String(LARGE_BODY.length),
      },
    });
    const out = await compressResponse(res, reqWith("br, gzip"));
    expect(out.headers.get("Content-Encoding")).toBe("gzip");

    const decompressed = new Response(
      out.body!.pipeThrough(new DecompressionStream("gzip")),
    );
    expect(await decompressed.text()).toBe(LARGE_BODY);
  });

  test("quality values in Accept-Encoding are stripped", async () => {
    const res = new Response(LARGE_BODY, {
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": String(LARGE_BODY.length),
      },
    });
    const out = await compressResponse(res, reqWith("br;q=0.5, gzip;q=0.8"));
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
  });

  test("compresses body without Content-Length if it clears the threshold", async () => {
    // No Content-Length forces the buffered path in compressResponse.
    const res = new Response(LARGE_BODY, {
      headers: { "Content-Type": "text/plain" },
    });
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
    expect(out.headers.get("Vary")).toContain("Accept-Encoding");

    const decompressed = new Response(
      out.body!.pipeThrough(new DecompressionStream("gzip")),
    );
    expect(await decompressed.text()).toBe(LARGE_BODY);
  });

  test("preserves original status code on compressed response", async () => {
    const res = new Response(LARGE_BODY, {
      status: 201,
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": String(LARGE_BODY.length),
      },
    });
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.status).toBe(201);
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
  });
});
