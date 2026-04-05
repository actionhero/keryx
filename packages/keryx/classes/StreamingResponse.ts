/**
 * Streaming response types for actions that need to send data incrementally.
 * Actions return a `StreamingResponse` from `run()` to stream over HTTP (SSE or chunked),
 * WebSocket (incremental messages), or MCP (logging messages + accumulated result).
 */

const encoder = new TextEncoder();

/**
 * Base class for streaming responses. Actions return this from `run()` to signal
 * that the response should be streamed rather than JSON-serialized.
 *
 * Use the static factories `StreamingResponse.sse()` or `StreamingResponse.stream()`
 * rather than constructing directly.
 */
export class StreamingResponse {
  /** The underlying readable stream delivered to the HTTP response body. */
  readonly stream: ReadableStream<Uint8Array>;
  /** Content-Type header for this streaming response. */
  readonly contentType: string;
  /** Extra headers to include in the HTTP response. */
  readonly headers: Record<string, string>;
  /** Called when the stream closes (used internally for connection cleanup). */
  onClose?: () => void;

  constructor(
    stream: ReadableStream<Uint8Array>,
    contentType: string,
    headers: Record<string, string> = {},
  ) {
    this.stream = stream;
    this.contentType = contentType;
    this.headers = headers;
  }

  /**
   * Create a Server-Sent Events streaming response. Returns an `SSEResponse`
   * with `send()` and `close()` methods for writing SSE-formatted events.
   *
   * @param options - Optional extra headers to include in the response.
   * @returns A new `SSEResponse` ready to send events.
   */
  static sse(options?: { headers?: Record<string, string> }): SSEResponse {
    return new SSEResponse(options?.headers);
  }

  /**
   * Wrap an existing `ReadableStream` as a streaming response for binary or
   * chunked transfer (e.g., file downloads, proxied responses).
   *
   * @param readableStream - The stream to deliver as the response body.
   * @param options - Content type and extra headers.
   * @returns A new `StreamingResponse` wrapping the provided stream.
   */
  static stream(
    readableStream: ReadableStream<Uint8Array>,
    options?: {
      contentType?: string;
      headers?: Record<string, string>;
    },
  ): StreamingResponse {
    return new StreamingResponse(
      readableStream,
      options?.contentType ?? "application/octet-stream",
      options?.headers ?? {},
    );
  }

  /**
   * Convert this streaming response into a native `Response` object, merging
   * the provided base headers (CORS, security, session cookie, etc.) with
   * the streaming-specific headers.
   *
   * @param baseHeaders - Headers from `buildHeaders()` to merge in.
   * @returns A native `Response` with the stream as its body.
   */
  toResponse(baseHeaders: Record<string, string>): Response {
    const mergedHeaders = { ...baseHeaders, ...this.headers };
    mergedHeaders["Content-Type"] = this.contentType;

    return new Response(this.stream, {
      status: 200,
      headers: mergedHeaders,
    });
  }
}

/**
 * Server-Sent Events streaming response. Provides `send()` to emit SSE-formatted
 * events and `close()` to end the stream.
 *
 * Events follow the SSE protocol: `event:`, `id:`, and `data:` fields separated
 * by `\n`, with events delimited by `\n\n`.
 */
export class SSEResponse extends StreamingResponse {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private closed = false;

  constructor(extraHeaders?: Record<string, string>) {
    let capturedController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        capturedController = controller;
      },
    });

    super(stream, "text/event-stream", {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...extraHeaders,
    });

    this.controller = capturedController!;
  }

  /**
   * Send an SSE event to the client.
   *
   * @param data - The event payload. Objects are JSON-serialized; strings are sent as-is
   *   (multiline strings are split into multiple `data:` lines per the SSE spec).
   * @param options - Optional `event` type name and `id` for the event.
   */
  send(data: string | object, options?: { event?: string; id?: string }): void {
    if (this.closed) return;

    let frame = "";
    if (options?.event) frame += `event: ${options.event}\n`;
    if (options?.id) frame += `id: ${options.id}\n`;

    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const line of payload.split("\n")) {
      frame += `data: ${line}\n`;
    }
    frame += "\n";

    this.controller?.enqueue(encoder.encode(frame));
  }

  /**
   * Send an error event and close the stream.
   *
   * @param error - Error message or object to send as an `error` event.
   */
  sendError(error: string | object): void {
    this.send(error, { event: "error" });
    this.close();
  }

  /** Close the SSE stream. Fires the `onClose` callback for connection cleanup. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    try {
      this.controller?.close();
    } catch (_e) {
      // Controller may already be closed (e.g., client disconnected)
    }

    this.onClose?.();
  }
}
