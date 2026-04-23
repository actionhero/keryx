import { describe, expect, test } from "bun:test";
import {
  SSEResponse,
  StreamingResponse,
} from "../../classes/StreamingResponse";

const decoder = new TextDecoder();

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("StreamingResponse.sse", () => {
  test("returns an SSEResponse with SSE headers", () => {
    const sse = StreamingResponse.sse();
    expect(sse).toBeInstanceOf(SSEResponse);
    expect(sse.contentType).toBe("text/event-stream");
    expect(sse.headers["Cache-Control"]).toBe("no-cache");
    expect(sse.headers["Connection"]).toBe("keep-alive");
    sse.close();
  });

  test("merges extra headers with SSE defaults", () => {
    const sse = StreamingResponse.sse({ headers: { "X-Custom": "yes" } });
    expect(sse.headers["X-Custom"]).toBe("yes");
    expect(sse.headers["Cache-Control"]).toBe("no-cache");
    sse.close();
  });
});

describe("StreamingResponse.stream", () => {
  test("wraps a stream with default octet-stream content type", () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const res = StreamingResponse.stream(stream);
    expect(res).toBeInstanceOf(StreamingResponse);
    expect(res.contentType).toBe("application/octet-stream");
  });

  test("honors contentType and headers overrides", () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const res = StreamingResponse.stream(stream, {
      contentType: "text/plain",
      headers: { "X-Foo": "bar" },
    });
    expect(res.contentType).toBe("text/plain");
    expect(res.headers["X-Foo"]).toBe("bar");
  });
});

describe("SSEResponse.send", () => {
  test("frames object payloads as JSON under a single data line", async () => {
    const sse = StreamingResponse.sse();
    sse.send({ index: 1, total: 3 });
    sse.close();

    const text = await collect(sse.stream);
    expect(text).toBe(`data: {"index":1,"total":3}\n\n`);
  });

  test("sends strings as-is and splits newlines across multiple data lines", async () => {
    const sse = StreamingResponse.sse();
    sse.send("line1\nline2");
    sse.close();

    const text = await collect(sse.stream);
    expect(text).toBe("data: line1\ndata: line2\n\n");
  });

  test("emits event and id fields when provided", async () => {
    const sse = StreamingResponse.sse();
    sse.send({ ok: true }, { event: "tick", id: "42" });
    sse.close();

    const text = await collect(sse.stream);
    expect(text).toBe(`event: tick\nid: 42\ndata: {"ok":true}\n\n`);
  });

  test("writes after close are silently ignored", async () => {
    const sse = StreamingResponse.sse();
    sse.send({ before: true });
    sse.close();
    sse.send({ after: true }); // should be a no-op

    const text = await collect(sse.stream);
    expect(text).toBe(`data: {"before":true}\n\n`);
  });
});

describe("SSEResponse.sendError", () => {
  test("emits an error event and closes the stream", async () => {
    const sse = StreamingResponse.sse();
    sse.sendError("boom");

    const text = await collect(sse.stream);
    expect(text).toBe("event: error\ndata: boom\n\n");

    // Subsequent writes should be ignored because the stream is closed.
    sse.send("after");
    expect(text).not.toContain("after");
  });
});

describe("SSEResponse.close", () => {
  test("fires onClose exactly once even when called multiple times", () => {
    const sse = StreamingResponse.sse();
    let fired = 0;
    sse.onClose = () => {
      fired++;
    };

    sse.close();
    sse.close();
    sse.close();

    expect(fired).toBe(1);
  });

  test("swallows errors from an already-closed underlying controller", () => {
    const sse = StreamingResponse.sse();
    sse.close();
    expect(() => sse.close()).not.toThrow();
  });
});

describe("StreamingResponse.toResponse", () => {
  test("merges base headers with streaming headers and sets Content-Type", () => {
    const sse = StreamingResponse.sse({ headers: { "X-Stream": "yes" } });
    const res = sse.toResponse({
      "X-Base": "1",
      "Content-Type": "should-be-overwritten",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("X-Base")).toBe("1");
    expect(res.headers.get("X-Stream")).toBe("yes");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    sse.close();
  });
});
