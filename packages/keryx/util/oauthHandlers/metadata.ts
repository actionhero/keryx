import { jsonResponse } from "./responses";
import { OAUTH_PATHS } from "./types";

/**
 * RFC 9728 — Protected Resource Metadata.
 * MCP clients fetch this first to discover the authorization server.
 */
export function handleProtectedResourceMetadata(
  origin: string,
  resourcePath: string,
): Response {
  const resource = resourcePath ? `${origin}${resourcePath}` : origin;
  return jsonResponse({
    resource,
    authorization_servers: [origin],
    scopes_supported: ["mcp"],
  });
}

/** OAuth 2.1 authorization server metadata endpoint (RFC 8414). */
export function handleMetadata(origin: string): Response {
  const issuer = origin;
  return jsonResponse({
    issuer,
    authorization_endpoint: `${issuer}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${issuer}${OAUTH_PATHS.token}`,
    registration_endpoint: `${issuer}${OAUTH_PATHS.register}`,
    introspection_endpoint: `${issuer}${OAUTH_PATHS.introspect}`,
    revocation_endpoint: `${issuer}${OAUTH_PATHS.revoke}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    introspection_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: false,
  });
}
