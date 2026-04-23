import { randomUUID } from "crypto";
import { api } from "../../api";
import { config } from "../../config";
import { validateRedirectUri } from "../oauth";
import { clientKey } from "./keys";
import { jsonResponse, oauthError } from "./responses";
import type { OAuthClient } from "./types";

/** Dynamic client registration endpoint (RFC 7591). */
export async function handleRegister(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return oauthError("invalid_request", "Invalid JSON body");
  }

  if (
    !body.redirect_uris ||
    !Array.isArray(body.redirect_uris) ||
    body.redirect_uris.length === 0
  ) {
    return oauthError("invalid_request", "redirect_uris is required");
  }

  for (const uri of body.redirect_uris) {
    if (typeof uri !== "string") {
      return oauthError(
        "invalid_request",
        "Each redirect_uri must be a string",
      );
    }
    const validation = validateRedirectUri(uri);
    if (!validation.valid) {
      // `error` is always populated when `valid` is false; see oauth.ts
      return oauthError("invalid_request", validation.error!);
    }
  }

  const clientId = randomUUID();
  const client: OAuthClient = {
    client_id: clientId,
    redirect_uris: body.redirect_uris,
    client_name: body.client_name,
    grant_types: body.grant_types ?? ["authorization_code"],
    response_types: body.response_types ?? ["code"],
    token_endpoint_auth_method: body.token_endpoint_auth_method ?? "none",
  };

  await api.redis.redis.set(
    clientKey(clientId),
    JSON.stringify(client),
    "EX",
    config.server.mcp.oauthClientTtl,
  );

  return jsonResponse(client, 201);
}
