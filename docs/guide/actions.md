---
description: How to write actions — inputs, validation, web routes, task scheduling, middleware, MCP exposure, and type helpers.
---

# Actions

If there's one idea that defines Keryx, it's this: **actions are the universal controller**. In the original ActionHero, we had actions, tasks, and CLI commands as separate concepts. That always felt like unnecessary duplication — you'd write the same validation logic three times for three different entry points. So in this version, we've collapsed them all into one thing.

An action is a class with a `name`, a Zod schema for `inputs`, and a `run()` method that returns data. You add a `web` property to make it an HTTP endpoint. You add a `task` property to make it a background job. CLI support comes for free. MCP tool exposure comes for free. Same validation, same error handling, same response shape — everywhere.

## A Simple Example

```ts
import { z } from "zod";
import { Action, api, HTTP_METHOD } from "keryx";

export class Status implements Action {
  name = "status";
  description = "Return the status of the server";
  inputs = z.object({});
  web = { route: "/status", method: HTTP_METHOD.GET };

  async run() {
    return {
      name: api.process.name,
      uptime: new Date().getTime() - api.bootTime,
    };
  }
}
```

That's a fully functioning HTTP endpoint, CLI command, and WebSocket handler. Hit `GET /api/status` from a browser, run `./keryx.ts status -q | jq` from the terminal, or send `{ action: "status" }` over a WebSocket — same action, same response.

## Properties

| Property      | Type                    | What it does                                                                   |
| ------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `name`        | `string`                | Unique identifier (e.g., `"user:create"`)                                      |
| `description` | `string`                | Human-readable description, shows up in CLI `--help` and Swagger               |
| `inputs`      | `z.ZodType`             | Zod schema — validation happens automatically                                  |
| `web`         | `{ route, method }`     | HTTP routing. Routes are strings with `:param` placeholders or RegExp patterns |
| `task`        | `{ queue, frequency? }` | Makes this action schedulable as a background job                              |
| `middleware`  | `ActionMiddleware[]`    | Runs before/after the action (auth, logging, etc.)                             |
| `mcp`         | `McpActionConfig`       | Controls MCP exposure: tool, resource, and/or prompt (tool enabled by default) |
| `timeout`     | `number`                | Per-action timeout in ms (overrides `config.actions.timeout`; `0` disables)    |

## Input Validation

Inputs use [Zod](https://zod.dev) schemas. If validation fails, the client gets a `406` with the validation errors — you don't need to write any error handling for bad inputs.

```ts
inputs = z.object({
  name: z.string().min(3).max(256),
  email: z
    .string()
    .email()
    .transform((val) => val.toLowerCase()),
  password: secret(z.string().min(8)),
});
```

### Secret Fields

You can mark sensitive fields with the `secret()` wrapper so they're redacted as `[[secret]]` in logs. Don't log passwords — use this:

```ts
import { secret } from "keryx";

inputs = z.object({
  password: secret(z.string().min(8)),
});
```

### Type Helpers

Two type helpers make your life easier:

- `ActionParams<A>` infers the validated input type from an action's Zod schema
- `ActionResponse<A>` infers the return type of an action's `run()` method

```ts
async run(params: ActionParams<UserCreate>) {
  // params.name, params.email, params.password — all typed
}
```

The frontend uses `ActionResponse<A>` to get type-safe API responses without any code generation.

## Web Routes

Add a `web` property to expose an action as an HTTP endpoint:

```ts
web = { route: "/user/:id", method: HTTP_METHOD.GET };
```

Routes support `:param` path parameters (like Express) and can also be RegExp patterns. There's no separate `routes.ts` file — the route lives on the action itself, right next to the handler that serves it.

Available methods: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`.

## Raw Response Passthrough

Sometimes you need full control over the HTTP response — file downloads, image serving, streaming, redirects. For those cases, return a `Response` object directly from `run()` and the framework passes it through unchanged, skipping JSON serialization entirely.

```ts
export class FileDownload implements Action {
  name = "file:download";
  middleware = [SessionMiddleware];
  web = { route: "/file/:id/download", method: HTTP_METHOD.GET };
  inputs = z.object({ id: z.string() });

  async run(params: ActionParams<FileDownload>) {
    const file = await getFileContent(params.id);
    return new Response(file.buffer, {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename="${file.name}"`,
      },
    });
  }
}
```

Your action still benefits from Keryx's routing, [middleware](/guide/middleware), session handling, and observability — all of that runs before `run()` is called. But the response itself is yours. Keryx's standard headers (CORS, security headers, session cookie) are **not** added to raw responses — you set your own headers on the `Response` you return.

This only applies to HTTP. WebSocket, CLI, and background task transports still expect JSON-serializable return values from `run()`.

## Streaming Responses

For Server-Sent Events (SSE), LLM streaming, or chunked binary transfers, return a `StreamingResponse` from `run()`. Unlike raw `Response` passthrough, streaming responses still get Keryx's standard headers (CORS, security, session cookie).

```ts
import { Action, HTTP_METHOD, StreamingResponse } from "keryx";

export class ChatStream implements Action {
  name = "chat:stream";
  description = "Stream an LLM response via SSE";
  web = { route: "/chat/stream", method: HTTP_METHOD.POST, streaming: true };
  timeout = 0; // disable timeout for long-running streams

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

Key points:

- **`StreamingResponse.sse()`** — SSE with `Content-Type: text/event-stream`, `Cache-Control: no-cache`. Use `send(data, { event?, id? })` to emit events and `close()` to end the stream.
- **`StreamingResponse.stream(readableStream, { contentType? })`** — raw binary/chunked streaming for file downloads or proxied responses.
- **`timeout = 0`** — streaming actions should disable the action timeout.
- **`web.streaming = true`** — tells Swagger to document the endpoint as `text/event-stream` instead of JSON.
- **Compression is skipped** for SSE responses automatically.
- **Connection cleanup is deferred** until the stream closes, so sessions and middleware state remain valid during streaming.

### Transport Behavior

| Transport | Behavior                                                                            |
| --------- | ----------------------------------------------------------------------------------- |
| HTTP      | Native SSE / chunked streaming                                                      |
| WebSocket | Incremental messages with `{ streaming: true, chunk }`, then `{ streaming: false }` |
| MCP       | Chunks sent as logging messages; accumulated text returned as tool result           |

See the dedicated [Streaming guide](/guide/streaming) for detailed examples and patterns.

## CLI Commands

Every action is automatically available as a CLI command. No extra configuration needed:

```bash
./keryx.ts "user:create" --name evan --email "evan@example.com" --password secret -q | jq
```

The `-q` flag suppresses server logs so you can pipe the JSON output cleanly. Use `--help` on any action to see its parameters. See the [CLI guide](/guide/cli#action-commands) for full details on flags, quiet mode, and error output.

## MCP Tools

When the MCP server is enabled, every action is automatically exposed as an [MCP](https://modelcontextprotocol.io) tool. AI agents can discover and call your actions through the Model Context Protocol — no extra configuration needed.

To exclude an action from MCP tools, set `mcp = { tool: false }`. Actions can also be registered as MCP resources or prompts via `mcp.resource` and `mcp.prompt`. See the [MCP guide](/guide/mcp) for full details.

## Task Scheduling

Add a `task` property to schedule an action as a recurring background job:

```ts
task = { queue: "default", frequency: 1000 * 60 * 60 }; // every hour
```

- `queue` — which Resque queue to use
- `frequency` — optional interval in ms for recurring execution

See [Tasks](/guide/tasks) for the full story on background processing and the fan-out pattern.

## Timeouts

Every action execution is wrapped with a timeout (default: 5 minutes). If an action exceeds its timeout, the framework aborts it and returns an HTTP `408` error with type `CONNECTION_ACTION_TIMEOUT`.

The global default is set in `config.actions.timeout` (env: `ACTION_TIMEOUT`). You can override it per-action:

```ts
export class SlowReport extends Action {
  name = "report:generate";
  timeout = 600_000; // 10 minutes for this action
  // ...
}
```

Set `timeout = 0` to disable the timeout for a specific action.

### AbortSignal

When timeouts are enabled, `run()` receives an `AbortSignal` as its third argument. Long-running actions should check the signal or pass it to cancellable APIs:

```ts
async run(params: ActionParams<SlowReport>, connection?: Connection, abortSignal?: AbortSignal) {
  const res = await fetch("https://slow-api.example.com/data", {
    signal: abortSignal,
  });
  // ...
}
```

If the action doesn't check the signal, the timeout still works — `Promise.race()` ensures the caller gets the timeout error immediately.

## Error Handling

Actions should throw `TypedError` for errors — not generic `Error`. Each error type maps to an HTTP status code:

```ts
import { ErrorType, TypedError } from "keryx";

throw new TypedError({
  message: "User not found",
  type: ErrorType.CONNECTION_ACTION_RUN, // → 500
});
```

Some common mappings: `CONNECTION_ACTION_PARAM_VALIDATION` → 406, `CONNECTION_SESSION_NOT_FOUND` → 401, `CONNECTION_ACTION_NOT_FOUND` → 404, `CONNECTION_RATE_LIMITED` → 429.

## Registration

New actions need to be re-exported from `backend/actions/.index.ts`. This is how the frontend gets type information about your API — it imports from that barrel file to power `ActionResponse<A>` on the client side.
