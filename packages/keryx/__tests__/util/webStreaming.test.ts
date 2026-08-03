import { describe, expect, test } from "bun:test";
import { StreamingResponse } from "../../classes/StreamingResponse";
import {
  isStreamingResponse,
  markStreamingResponse,
} from "../../util/webStreaming";

describe("webStreaming", () => {
  test("an unmarked response is not streaming", () => {
    const res = new Response("hello", {
      headers: { "Content-Type": "text/plain" },
    });
    expect(isStreamingResponse(res)).toBe(false);
  });

  test("markStreamingResponse marks the response and returns it", () => {
    const res = new Response("hello");
    expect(markStreamingResponse(res)).toBe(res);
    expect(isStreamingResponse(res)).toBe(true);
  });

  test("the mark does not leak into response headers", () => {
    const res = markStreamingResponse(new Response("hello"));
    const headerNames = [...res.headers.keys()];
    expect(headerNames.some((h) => h.toLowerCase().includes("stream"))).toBe(
      false,
    );
  });

  test("the mark is per-response, not shared", () => {
    markStreamingResponse(new Response("marked"));
    expect(isStreamingResponse(new Response("other"))).toBe(false);
  });

  test("text/event-stream is streaming even without a mark", () => {
    const res = new Response("data: hi\n\n", {
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
    expect(isStreamingResponse(res)).toBe(true);
  });

  test("StreamingResponse.toResponse marks its output", () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const res = StreamingResponse.stream(stream, {
      contentType: "application/octet-stream",
    }).toResponse({});

    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(isStreamingResponse(res)).toBe(true);
  });

  test("SSE responses built by StreamingResponse are streaming too", () => {
    const res = StreamingResponse.sse().toResponse({});
    expect(isStreamingResponse(res)).toBe(true);
  });
});
