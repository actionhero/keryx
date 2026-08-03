import { afterAll, describe, expect, test } from "bun:test";
import { StreamingResponse } from "../../classes/StreamingResponse";
import { config } from "../../config";
import { compressResponse } from "../../util/webCompression";
import { markStreamingResponse } from "../../util/webStreaming";

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

describe("compressResponse with streaming bodies", () => {
  /** A stream of `count` chunks of `chunkSize` bytes, counting how many were pulled. */
  function countingStream(count: number, chunkSize: number) {
    const counter = { pulled: 0 };
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= count) return controller.close();
        counter.pulled++;
        emitted++;
        controller.enqueue(new Uint8Array(chunkSize).fill(97)); // "a"
      },
    });
    return { stream, counter, totalBytes: count * chunkSize };
  }

  test("returns a marked streaming response untouched", async () => {
    const res = markStreamingResponse(
      new Response(new Blob([LARGE_BODY]).stream(), {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
    const out = await compressResponse(res, reqWith("gzip"));
    expect(out).toBe(res);
    expect(out.headers.get("Content-Encoding")).toBeNull();
  });

  test("returns a StreamingResponse.stream() response untouched", async () => {
    // The exact shape of issue #525: a non-SSE stream with a compressible content type,
    // requested by a client that advertises gzip.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(LARGE_BODY));
        controller.close();
      },
    });
    const res = StreamingResponse.stream(stream, {
      contentType: "text/plain",
    }).toResponse({});

    const out = await compressResponse(res, reqWith("gzip"));
    expect(out).toBe(res);
    expect(out.headers.get("Content-Encoding")).toBeNull();
    expect(await out.text()).toBe(LARGE_BODY);
  });

  test("does not wait for an unclosed body to end before responding", async () => {
    // Before the fix this called arrayBuffer(), which only settles when the stream closes —
    // so a long-lived stream never produced a response at all.
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(new Uint8Array(4096).fill(98));
      },
    });
    const res = new Response(stream, {
      headers: { "Content-Type": "text/plain" },
    });

    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.headers.get("Content-Encoding")).toBe("gzip");

    controller.close();
    await out.body!.cancel();
  });

  test("reads no more than the threshold before deciding to compress", async () => {
    const { stream, counter } = countingStream(40, 512); // 20 KB total, 1 KB threshold
    const res = new Response(stream, {
      headers: { "Content-Type": "text/plain" },
    });

    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
    // A couple of chunks clear the 1024-byte threshold; the other ~37 must still be
    // unread, i.e. buffered memory is bounded by the threshold and not by body size.
    expect(counter.pulled).toBeLessThanOrEqual(4);

    await out.body!.cancel();
  });

  test("compressed chunked body round-trips with no bytes lost or duplicated", async () => {
    // Exercises the seam between the chunks buffered for the threshold check and the
    // remainder still in the reader.
    const { stream, totalBytes } = countingStream(40, 512);
    const res = new Response(stream, {
      headers: { "Content-Type": "text/plain" },
    });

    const out = await compressResponse(res, reqWith("gzip"));
    const decompressed = new Response(
      out.body!.pipeThrough(new DecompressionStream("gzip")),
    );
    const text = await decompressed.text();
    expect(text.length).toBe(totalBytes);
    expect(text).toBe("a".repeat(totalBytes));
  });

  test("a chunked body under the threshold is reassembled intact", async () => {
    const { stream, totalBytes } = countingStream(3, 100); // 300 bytes, under threshold
    const res = new Response(stream, {
      headers: { "Content-Type": "text/plain" },
    });

    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.headers.get("Content-Encoding")).toBeNull();
    expect(await out.text()).toBe("a".repeat(totalBytes));
  });

  test("an empty chunked body is handled without throwing", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const res = new Response(stream, {
      headers: { "Content-Type": "text/plain" },
    });

    const out = await compressResponse(res, reqWith("gzip"));
    expect(out.headers.get("Content-Encoding")).toBeNull();
    expect(await out.text()).toBe("");
  });
});
