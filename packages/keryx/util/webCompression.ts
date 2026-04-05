import { config } from "../config";

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
function selectEncoding(clientEncodings: Set<string>): "br" | "gzip" | null {
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
 * Conditionally compress an HTTP response based on the client's `Accept-Encoding` header,
 * the response content type, and the configured compression threshold.
 *
 * Uses the Web Streams `CompressionStream` API for async, non-blocking compression.
 * Skips compression for empty bodies, already-encoded responses, incompressible content
 * types, and responses below the size threshold.
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

  // Never compress SSE streams
  if (response.headers.get("Content-Type")?.includes("text/event-stream"))
    return response;

  // Already compressed
  if (response.headers.get("Content-Encoding")) return response;

  // Check client support
  const acceptEncoding = req.headers.get("Accept-Encoding");
  if (!acceptEncoding) return response;

  const clientEncodings = parseAcceptEncoding(acceptEncoding);
  const encoding = selectEncoding(clientEncodings);
  if (!encoding) return response;

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

  // For responses without Content-Length, we need to read the body to check size
  // This covers most of our responses (JSON action responses, error responses)
  if (!contentLength) {
    const body = await response.arrayBuffer();
    if (body.byteLength < config.server.web.compression.threshold) {
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    }

    // Compress the buffered body
    const format: Bun.CompressionFormat = encoding === "br" ? "brotli" : "gzip";
    // @ts-ignore Bun supports "brotli" as CompressionFormat but DOM lib does not
    const compressionStream = new CompressionStream(format);
    // @ts-ignore Bun's ReadableStream type is incompatible with Node/DOM ReadableStream
    const stream = new Blob([body]).stream().pipeThrough(compressionStream);

    const headers = new Headers(response.headers);
    headers.set("Content-Encoding", encoding);
    headers.append("Vary", "Accept-Encoding");
    headers.delete("Content-Length");

    // @ts-ignore Bun's ReadableStream type is incompatible with Node/DOM ReadableStream
    return new Response(stream, {
      status: response.status,
      headers,
    });
  }

  // Content-Length is present and above threshold — stream-compress
  const format: Bun.CompressionFormat = encoding === "br" ? "brotli" : "gzip";
  // @ts-ignore Bun supports "brotli" as CompressionFormat but DOM lib does not
  const compressionStream = new CompressionStream(format);
  // @ts-ignore Bun's ReadableStream type is incompatible with Node/DOM ReadableStream
  const stream = response.body.pipeThrough(compressionStream);

  const headers = new Headers(response.headers);
  headers.set("Content-Encoding", encoding);
  headers.append("Vary", "Accept-Encoding");
  headers.delete("Content-Length");

  // @ts-ignore Bun's ReadableStream type is incompatible with Node/DOM ReadableStream
  return new Response(stream, {
    status: response.status,
    headers,
  });
}
