import { describe, expect, test } from "bun:test";
import { type ActionResponse } from "keryx";
import type { StreamingCounter } from "../../actions/streaming";
import { useTestServer } from "./../setup";

const getUrl = useTestServer();

function parseSSE(
  text: string,
): Array<{ event?: string; id?: string; data: string }> {
  const events: Array<{ event?: string; id?: string; data: string }> = [];
  for (const block of text.split("\n\n").filter(Boolean)) {
    let event: string | undefined;
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (dataLines.length > 0)
      events.push({ event, id, data: dataLines.join("\n") });
  }
  return events;
}

describe("streaming:counter", () => {
  test("emits text/event-stream headers", async () => {
    const res = await fetch(getUrl() + "/api/streaming/counter?count=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    await res.text();
  });

  test("sends exactly N counter events in order, then closes", async () => {
    const res = await fetch(getUrl() + "/api/streaming/counter?count=3");
    const text = await res.text();
    const events = parseSSE(text);

    expect(events).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(events[i].event).toBe("counter");
      const data = JSON.parse(events[i].data) as {
        index: number;
        total: number;
      };
      expect(data.index).toBe(i + 1);
      expect(data.total).toBe(3);
    }
  });

  test("default count is 5 when omitted", async () => {
    const res = await fetch(getUrl() + "/api/streaming/counter");
    const text = await res.text();
    const events = parseSSE(text);
    expect(events).toHaveLength(5);
  });

  test("rejects count below min with 406", async () => {
    const res = await fetch(getUrl() + "/api/streaming/counter?count=0");
    expect(res.status).toBe(406);
    const body = (await res.json()) as ActionResponse<StreamingCounter>;
    expect(body.error).toBeDefined();
  });

  test("rejects count above max with 406", async () => {
    const res = await fetch(getUrl() + "/api/streaming/counter?count=101");
    expect(res.status).toBe(406);
    const body = (await res.json()) as ActionResponse<StreamingCounter>;
    expect(body.error).toBeDefined();
  });
});
