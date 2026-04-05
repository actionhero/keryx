import { Action, HTTP_METHOD, StreamingResponse } from "keryx";
import { z } from "zod";

export class StreamingCounter implements Action {
  name = "streaming:counter";
  description =
    "Streams a sequence of counter events via Server-Sent Events. Sends one numbered event per 100ms, then closes. Useful for testing SSE client implementations.";
  inputs = z.object({
    count: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(5)
      .describe("Number of events to send (1–100, default 5)"),
  });
  web = {
    route: "/streaming/counter",
    method: HTTP_METHOD.GET,
    streaming: true,
  };
  timeout = 0;
  mcp = { tool: false };

  async run(params: { count: number }) {
    const sse = StreamingResponse.sse();

    (async () => {
      try {
        for (let i = 1; i <= params.count; i++) {
          await Bun.sleep(100);
          sse.send({ index: i, total: params.count }, { event: "counter" });
        }
      } catch (e) {
        sse.sendError(String(e));
      } finally {
        sse.close();
      }
    })();

    return sse;
  }
}
