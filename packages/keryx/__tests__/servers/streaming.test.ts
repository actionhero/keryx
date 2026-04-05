import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { api } from "../../api";
import { type Action, HTTP_METHOD } from "../../classes/Action";
import { StreamingResponse } from "../../classes/StreamingResponse";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

let url: string;

beforeAll(async () => {
  await api.start();
  url = serverUrl();

  // SSE action that sends a configurable number of counter events
  const sseAction = {
    name: "test:sse",
    inputs: z.object({
      count: z.coerce.number().int().min(1).max(50).default(3),
    }),
    web: { route: "/test/sse", method: HTTP_METHOD.GET, streaming: true },
    timeout: 0,
    run: async (params: { count: number }) => {
      const sse = StreamingResponse.sse();
      (async () => {
        for (let i = 1; i <= params.count; i++) {
          sse.send({ index: i }, { event: "counter", id: String(i) });
        }
        sse.close();
      })();
      return sse;
    },
  } as unknown as Action;

  // Raw binary streaming action
  const streamAction = {
    name: "test:stream",
    inputs: z.object({}),
    web: { route: "/test/stream", method: HTTP_METHOD.GET },
    timeout: 0,
    run: async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("chunk1"));
          controller.enqueue(encoder.encode("chunk2"));
          controller.enqueue(encoder.encode("chunk3"));
          controller.close();
        },
      });
      return StreamingResponse.stream(stream, {
        contentType: "application/octet-stream",
      });
    },
  } as unknown as Action;

  // SSE action that sends an error mid-stream
  const sseErrorAction = {
    name: "test:sseError",
    inputs: z.object({}),
    web: { route: "/test/sse-error", method: HTTP_METHOD.GET, streaming: true },
    timeout: 0,
    run: async () => {
      const sse = StreamingResponse.sse();
      (async () => {
        sse.send({ ok: true }, { event: "data" });
        sse.sendError("something went wrong");
      })();
      return sse;
    },
  } as unknown as Action;

  api.actions.actions.push(sseAction, streamAction, sseErrorAction);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Parse raw SSE text into an array of event objects.
 */
function parseSSE(
  text: string,
): Array<{ event?: string; id?: string; data: string }> {
  const events: Array<{ event?: string; id?: string; data: string }> = [];
  const blocks = text.split("\n\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    let event: string | undefined;
    let id: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }

    if (dataLines.length > 0) {
      events.push({ event, id, data: dataLines.join("\n") });
    }
  }

  return events;
}

describe("SSE streaming", () => {
  test("returns correct SSE headers", async () => {
    const res = await fetch(url + "/api/test/sse");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    await res.text(); // consume body
  });

  test("includes standard keryx headers (CORS, security, session)", async () => {
    const res = await fetch(url + "/api/test/sse");
    expect(res.headers.get("X-SERVER-NAME")).toBeTruthy();
    expect(res.headers.get("Set-Cookie")).toBeTruthy();
    await res.text();
  });

  test("streams counter events with correct SSE format", async () => {
    const res = await fetch(url + "/api/test/sse?count=3");
    const text = await res.text();
    const events = parseSSE(text);

    expect(events).toHaveLength(3);
    expect(events[0].event).toBe("counter");
    expect(events[0].id).toBe("1");
    expect(JSON.parse(events[0].data)).toEqual({ index: 1 });
    expect(events[2].id).toBe("3");
    expect(JSON.parse(events[2].data)).toEqual({ index: 3 });
  });

  test("does not compress SSE responses", async () => {
    const res = await fetch(url + "/api/test/sse?count=5", {
      headers: { "Accept-Encoding": "gzip, br" },
    });
    expect(res.headers.get("Content-Encoding")).toBeNull();
    await res.text();
  });

  test("SSE error event sends error and closes stream", async () => {
    const res = await fetch(url + "/api/test/sse-error");
    const text = await res.text();
    const events = parseSSE(text);

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("data");
    expect(events[1].event).toBe("error");
    expect(events[1].data).toBe("something went wrong");
  });
});

describe("raw streaming", () => {
  test("streams binary chunks with correct content type", async () => {
    const res = await fetch(url + "/api/test/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    const text = await res.text();
    expect(text).toBe("chunk1chunk2chunk3");
  });
});
