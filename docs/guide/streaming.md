---
description: Stream data over HTTP with Server-Sent Events or chunked binary responses — same action, all transports.
---

# Streaming

In the AI agent era, streaming is table stakes. LLM responses arrive token by token, progress updates trickle in over seconds, and long-running operations need to show they're alive. Keryx supports streaming natively — return a `StreamingResponse` from your action's `run()` method and the framework handles the rest.

## Server-Sent Events (SSE)

SSE is the right tool for most streaming use cases: LLM token streaming, real-time progress, live data feeds. It's simpler than WebSocket (unidirectional, auto-reconnect built into browsers) and works everywhere HTTP works.

```ts
import { Action, HTTP_METHOD, StreamingResponse } from "keryx";
import { z } from "zod";

export class ChatStream implements Action {
  name = "chat:stream";
  description = "Stream an LLM response via SSE";
  inputs = z.object({ prompt: z.string() });
  web = { route: "/chat/stream", method: HTTP_METHOD.POST, streaming: true };
  timeout = 0;

  async run(params: { prompt: string }) {
    const sse = StreamingResponse.sse();

    (async () => {
      try {
        for await (const token of callLLM(params.prompt)) {
          sse.send(token, { event: "token" });
        }
        sse.send({ done: true }, { event: "done" });
      } catch (e) {
        sse.sendError(String(e));
      } finally {
        sse.close();
      }
    })();

    return sse;
  }
}
```

A few things to notice:

- **`StreamingResponse.sse()`** creates the stream and returns immediately. The async IIFE runs in the background, calling `send()` as data becomes available.
- **`timeout = 0`** disables the action timeout. Streaming actions can run for minutes or hours — you don't want the framework killing them after 5 minutes.
- **`web.streaming = true`** tells Swagger to document this endpoint as `text/event-stream` instead of `application/json`.
- **`sse.close()`** is mandatory. Always close the stream when you're done, even in error paths. The `finally` block is your friend.

### The `send()` Method

```ts
sse.send(data, { event?, id? })
```

- **`data`** — A string or an object. Objects are JSON-serialized. Multiline strings are split into multiple `data:` lines per the SSE spec.
- **`event`** — Optional event type name. Clients can listen for specific events with `EventSource.addEventListener("token", ...)`.
- **`id`** — Optional event ID. Clients use this for reconnection — the browser sends the last ID in the `Last-Event-ID` header on reconnect.

### Error Handling

If something goes wrong mid-stream, don't just close — tell the client what happened:

```ts
sse.sendError("upstream timeout");
// This sends an event with type "error", then closes the stream
```

Clients should listen for the `error` event type to handle these gracefully.

## Binary / Chunked Streaming

For file downloads, proxied responses, or any binary data that doesn't fit the SSE format:

```ts
async run() {
  const fileStream = Bun.file("large-export.csv").stream();
  return StreamingResponse.stream(fileStream, {
    contentType: "text/csv",
    headers: {
      "Content-Disposition": 'attachment; filename="export.csv"',
    },
  });
}
```

This wraps any `ReadableStream<Uint8Array>` with the right headers and delivers it as a chunked HTTP response.

## What You Get for Free

Unlike raw `Response` passthrough, `StreamingResponse` gives you Keryx's standard headers:

- **CORS** — `Access-Control-Allow-Origin` and friends, based on your config
- **Security headers** — CSP, HSTS, X-Content-Type-Options
- **Session cookie** — set automatically so the client maintains its session
- **Rate limit headers** — if rate limiting middleware ran before the stream started
- **Correlation ID** — propagated from the incoming request

Compression is automatically skipped for SSE responses — compressing a real-time event stream adds latency with no benefit.

## Transport Behavior

The same action works across all transports, but streaming behaves differently in each:

| Transport       | Behavior                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP**        | Native SSE or chunked streaming. The connection stays open until `close()`.                                                                       |
| **WebSocket**   | Each chunk becomes an incremental message: `{ messageId, streaming: true, chunk }`. A final `{ messageId, streaming: false }` signals completion. |
| **MCP**         | Chunks are forwarded as logging messages for real-time visibility. The full accumulated text is returned as the tool result.                      |
| **CLI / Tasks** | The stream is consumed and the result is collected — no incremental output.                                                                       |

## Connection Lifecycle

Normally, Keryx destroys the connection immediately after `run()` returns. For streaming responses, cleanup is deferred until the stream closes. This means:

- Your session remains valid during streaming
- Middleware state is preserved
- The connection appears in `api.connections` for the duration of the stream

One gotcha: `runAfter` middleware executes right after `run()` returns the `StreamingResponse` object, not after the stream closes. If middleware tries to replace the response via `updatedResponse`, it's ignored (with a warning log). Middleware that reads connection state or records metrics still works fine.

## Middleware Compatibility

- **`runBefore`** — works normally. Auth checks, rate limiting, param mutation — all happen before streaming starts.
- **`runAfter`** — runs after `run()` returns the `StreamingResponse`, before the stream is consumed. Cannot replace the response. Useful for logging or recording that a stream was initiated.

## Tips

- **Always set `timeout = 0`** on streaming actions. The default 5-minute timeout will abort your stream.
- **Always call `close()`** in a `finally` block. Unclosed streams leak connections.
- **Set `mcp.tool = false`** if the streaming action doesn't make sense as an MCP tool (most LLM streaming endpoints don't).
- **Use event types** to structure your SSE stream. Clients can subscribe to specific events rather than parsing every message.
