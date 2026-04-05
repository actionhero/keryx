import type { Connection } from "../classes/Connection";
import { StreamingResponse } from "../classes/StreamingResponse";
import { TypedError } from "../classes/TypedError";
import { config } from "../config";
import { buildCorsHeaders } from "../util/http";

export const EOL = "\r\n";

export function getSecurityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    config.server.web.securityHeaders,
  )) {
    if (value) headers[key] = value;
  }
  return headers;
}

export const buildHeaders = (
  connection?: Connection,
  requestOrigin?: string,
) => {
  const headers: Record<string, string> = {};

  headers["Content-Type"] = "application/json";
  headers["X-SERVER-NAME"] = config.process.name;

  const cors = buildCorsHeaders(requestOrigin, {
    "Access-Control-Allow-Methods": config.server.web.allowedMethods,
    "Access-Control-Allow-Headers": config.server.web.allowedHeaders,
  });
  if (cors["Access-Control-Allow-Origin"] && cors["Vary"]) {
    // Specific origin match (not wildcard) — allow credentials
    cors["Access-Control-Allow-Credentials"] = "true";
  }
  Object.assign(headers, cors);

  Object.assign(headers, getSecurityHeaders());

  if (connection) {
    const secure =
      config.session.cookieSecure ||
      config.server.web.applicationUrl.startsWith("https");
    const flags = [
      `${config.session.cookieName}=${connection.id}`,
      `Max-Age=${config.session.ttl}`,
      "Path=/",
      config.session.cookieHttpOnly ? "HttpOnly" : "",
      `SameSite=${config.session.cookieSameSite}`,
      secure ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; ");
    headers["Set-Cookie"] = flags;

    if (connection.rateLimitInfo) {
      const rateLimitInfo = connection.rateLimitInfo;
      headers["X-RateLimit-Limit"] = String(rateLimitInfo.limit);
      headers["X-RateLimit-Remaining"] = String(rateLimitInfo.remaining);
      headers["X-RateLimit-Reset"] = String(rateLimitInfo.resetAt);
      if (rateLimitInfo.retryAfter !== undefined) {
        headers["Retry-After"] = String(rateLimitInfo.retryAfter);
      }
    }

    if (config.server.web.correlationId.header && connection.correlationId) {
      headers[config.server.web.correlationId.header] =
        connection.correlationId;
    }
  }

  return headers;
};

export function buildResponse(
  connection: Connection,
  response: Object,
  status = 200,
  requestOrigin?: string,
) {
  if (response instanceof StreamingResponse) {
    return response.toResponse(buildHeaders(connection, requestOrigin));
  }

  if (response instanceof Response) {
    return response;
  }

  return new Response(JSON.stringify(response, null, 2) + EOL, {
    status,
    headers: buildHeaders(connection, requestOrigin),
  });
}

export function buildError(
  connection: Connection | undefined,
  error: TypedError,
  status = 500,
  requestOrigin?: string,
) {
  return new Response(
    JSON.stringify({ error: buildErrorPayload(error) }, null, 2) + EOL,
    {
      status,
      headers: buildHeaders(connection, requestOrigin),
    },
  );
}

export function buildErrorPayload(error: TypedError) {
  return {
    message: error.message,
    type: error.type,
    timestamp: new Date().getTime(),
    key: error.key !== undefined ? error.key : undefined,
    value: error.value !== undefined ? error.value : undefined,
    ...(config.server.web.includeStackInErrors ? { stack: error.stack } : {}),
  };
}
