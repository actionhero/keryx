import { config } from "../config";
import { isStreamingResponse } from "./webStreaming";

const INCOMPRESSIBLE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "audio/mpeg",
  "audio/ogg",
  "audio/webm",
  "application/zip",
  "application/gzip",
  "application/x-bzip2",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/wasm",
]);

/**
 * Parse the `Accept-Encoding` header and return the set of encodings the client supports.
 */
function parseAcceptEncoding(header: string): Set<string> {
  const encodings = new Set<string>();
  for (const part of header.split(",")) {
    const encoding = part.split(";")[0].trim().toLowerCase();
    if (encoding) encodings.add(encoding);
  }
  return encodings;
}

/**
 * Pick the best encoding based on server preference order and client support.
 */
function selectEncoding(clientEncodings: Set<string>): "gzip" | null {
  for (const encoding of config.server.web.compression.encodings) {
    if (clientEncodings.has(encoding)) return encoding;
  }
  return null;
}

/**
 * Check whether a content type is already compressed and would not benefit from further compression.
 */
function isIncompressible(contentType: string | null): boolean {
  if (!contentType) return false;
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  return INCOMPRESSIBLE_TYPES.has(mimeType);
}

/**
 * Pipe a body through a gzip `CompressionStream` and build a new `Response` carrying the
 * compression headers (`Content-Encoding`, appended `Vary`, removed `Content-Length`).
 */
function compressBody(body: ReadableStream, response: Response): Response {
  const compressionStream = new CompressionStream("gzip");
  // @ts-ignore Bun's ReadableStream type is incompatible with Node/DOM ReadableStream
  const stream = body.pipeThrough(compressionStream);

  const headers = new Headers(response.headers);
  headers.set("Content-Encoding", "gzip");
  headers.append("Vary", "Accept-Encoding");
  headers.delete("Content-Length");

  // @ts-ignore Bun's ReadableStream type is incompatible with Node/DOM ReadableStream
  return new Response(stream, { status: response.status, headers });
}

/**
 * Reader/stream shapes described structurally, because Bun's and Node's `ReadableStream`
 * typings disagree over members like `readMany` — a `Response.body` satisfies either.
 */
type BodyReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
};
type BodyStream = { getReader(): BodyReader };

/**
 * Read from a body stream until at least `limit` bytes are buffered or the stream ends.
 *
 * Used to answer "does this response clear the compression threshold?" for bodies with no
 * `Content-Length`, without draining the whole body. The reader is returned still locked to
 * the stream so the caller can resume from where this stopped.
 *
 * @param body The response body to read from.
 * @param limit Stop reading once this many bytes have been buffered.
 * @returns The buffered chunks, their total size, whether the stream ended, and the reader.
 */
async function readUpTo(
  body: BodyStream,
  limit: number,
): Promise<{
  chunks: Uint8Array[];
  size: number;
  ended: boolean;
  reader: BodyReader;
}> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) return { chunks, size, ended: true, reader };
    if (value?.byteLength) {
      chunks.push(value);
      size += value.byteLength;
    }
  }

  return { chunks, size, ended: false, reader };
}

/**
 * Flatten buffered chunks into a single view over a fresh `ArrayBuffer` of exactly `size`
 * bytes — a concrete `ArrayBuffer` rather than `ArrayBufferLike`, so the result is a valid
 * `BodyInit` under both the Bun and DOM lib typings.
 */
function concatChunks(
  chunks: Uint8Array[],
  size: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Rebuild a body stream from the chunks already read plus the rest of the reader, so a
 * partially-consumed body can be piped onward without buffering what remains.
 */
function restoreStream(
  chunks: Uint8Array[],
  reader: BodyReader,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      if (value) controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Conditionally compress an HTTP response based on the client's `Accept-Encoding` header,
 * the response content type, and the configured compression threshold.
 *
 * Uses the Web Streams `CompressionStream` API for async, non-blocking compression.
 * Skips compression for empty bodies, streaming responses, already-encoded responses,
 * incompressible content types, and responses below the size threshold.
 *
 * Bodies with no `Content-Length` are measured by reading at most `threshold` bytes, never
 * the whole body — memory stays bounded and a large or slow response keeps flowing.
 *
 * @param response The original Response to potentially compress
 * @param req The incoming Request (used to read Accept-Encoding)
 * @returns A new compressed Response, or the original if compression was skipped
 */
export async function compressResponse(
  response: Response,
  req: Request,
): Promise<Response> {
  if (!config.server.web.compression.enabled) return response;

  // No body to compress
  if (!response.body) return response;

  // Never touch a streaming body — SSE, chunked downloads, proxied responses. Compressing
  // one would mean handing it to a CompressionStream that is free to withhold output until
  // it has enough bytes to be worth a gzip block, which defeats incremental delivery.
  if (isStreamingResponse(response)) return response;

  // Already compressed
  if (response.headers.get("Content-Encoding")) return response;

  // Check client support
  const acceptEncoding = req.headers.get("Accept-Encoding");
  if (!acceptEncoding) return response;

  const clientEncodings = parseAcceptEncoding(acceptEncoding);
  if (!selectEncoding(clientEncodings)) return response;

  // Skip incompressible content types
  if (isIncompressible(response.headers.get("Content-Type"))) return response;

  // Check threshold using Content-Length if available
  const contentLength = response.headers.get("Content-Length");
  if (
    contentLength &&
    parseInt(contentLength, 10) < config.server.web.compression.threshold
  ) {
    return response;
  }

  // Without a Content-Length the size is unknown until the body is read — which covers most
  // of our responses (JSON action responses, error responses). Read only as far as the
  // threshold, which is all it takes to answer "is this worth compressing?", then either
  // return the buffered bytes as-is or stream-compress the buffered prefix plus the rest.
  // Draining the whole body here would hold an arbitrarily large response in memory and
  // stall delivery until the body closed.
  if (!contentLength) {
    const threshold = config.server.web.compression.threshold;
    const { chunks, size, ended, reader } = await readUpTo(
      response.body,
      threshold,
    );

    if (ended) {
      // The whole body fit under the threshold, so send exactly those bytes back.
      return new Response(size > 0 ? concatChunks(chunks, size) : null, {
        status: response.status,
        headers: response.headers,
      });
    }

    return compressBody(restoreStream(chunks, reader), response);
  }

  // Content-Length is present and above threshold — stream-compress
  return compressBody(response.body, response);
}
