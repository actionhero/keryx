import { randomUUID } from "crypto";
import { api } from "../api";
import type { Action, OAuthActionResponse } from "../classes/Action";
import { Connection } from "../classes/Connection";
import { config } from "../config";
import {
  base64UrlEncode,
  redirectUrisMatch,
  validateRedirectUri,
} from "./oauth";
import {
  type AuthPageParams,
  type OAuthTemplates,
  renderAuthPage,
  renderSuccessPage,
} from "./oauthTemplates";

export type OAuthClient = {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
};

export type AuthCode = {
  clientId: string;
  userId: number;
  codeChallenge: string;
  redirectUri: string;
};

export type TokenData = {
  userId: number;
  clientId: string;
  scopes: string[];
};

/** OAuth protocol fields that should not be forwarded to login/signup actions. */
const OAUTH_FIELDS = new Set([
  "mode",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "response_type",
  "state",
]);

/**
 * RFC 9728 — Protected Resource Metadata.
 * MCP clients fetch this first to discover the authorization server.
 */
export function handleProtectedResourceMetadata(
  origin: string,
  resourcePath: string,
): Response {
  const resource = resourcePath ? `${origin}${resourcePath}` : origin;
  return new Response(
    JSON.stringify({
      resource,
      authorization_servers: [origin],
      scopes_supported: ["mcp"],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** OAuth 2.1 authorization server metadata endpoint. */
export function handleMetadata(origin: string): Response {
  const issuer = origin;
  return new Response(
    JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: false,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** Dynamic client registration endpoint (RFC 7591). */
export async function handleRegister(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "Invalid JSON body",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (
    !body.redirect_uris ||
    !Array.isArray(body.redirect_uris) ||
    body.redirect_uris.length === 0
  ) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "redirect_uris is required",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  for (const uri of body.redirect_uris) {
    if (typeof uri !== "string") {
      return new Response(
        JSON.stringify({
          error: "invalid_request",
          error_description: "Each redirect_uri must be a string",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const validation = validateRedirectUri(uri);
    if (!validation.valid) {
      return new Response(
        JSON.stringify({
          error: "invalid_request",
          error_description: validation.error,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
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
    `oauth:client:${clientId}`,
    JSON.stringify(client),
    "EX",
    config.server.mcp.oauthClientTtl,
  );

  return new Response(JSON.stringify(client), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

/** Render the OAuth authorize page (GET). */
export function handleAuthorizeGet(
  url: URL,
  templates: OAuthTemplates,
): Response {
  const params: AuthPageParams = {
    clientId: url.searchParams.get("client_id") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    codeChallenge: url.searchParams.get("code_challenge") ?? "",
    codeChallengeMethod: url.searchParams.get("code_challenge_method") ?? "",
    responseType: url.searchParams.get("response_type") ?? "",
    state: url.searchParams.get("state") ?? "",
    error: "",
  };

  return renderAuthPage(params, templates, {
    loginAction: api.actions.actions.find((a: Action) => a.mcp?.isLoginAction),
    signupAction: api.actions.actions.find(
      (a: Action) => a.mcp?.isSignupAction,
    ),
  });
}

/** Handle the OAuth authorize form POST (signin/signup). */
export async function handleAuthorizePost(
  req: Request,
  templates: OAuthTemplates,
): Promise<Response> {
  let fields: Record<string, string>;
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      const params = new URLSearchParams(text);
      fields = Object.fromEntries(params.entries());
    } else {
      const form = await req.formData();
      fields = {};
      form.forEach((value, key) => {
        fields[key] = String(value);
      });
    }
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const mode = fields.mode ?? "";
  const clientId = fields.client_id ?? "";
  const redirectUri = fields.redirect_uri ?? "";
  const codeChallenge = fields.code_challenge ?? "";
  const codeChallengeMethod = fields.code_challenge_method ?? "";
  const responseType = fields.response_type ?? "";
  const state = fields.state ?? "";

  const oauthParams: AuthPageParams = {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    responseType,
    state,
    error: "",
  };

  const authActions = {
    loginAction: api.actions.actions.find((a: Action) => a.mcp?.isLoginAction),
    signupAction: api.actions.actions.find(
      (a: Action) => a.mcp?.isSignupAction,
    ),
  };

  // Validate client
  const clientRaw = await api.redis.redis.get(`oauth:client:${clientId}`);
  if (!clientRaw) {
    oauthParams.error = "Unknown client";
    return renderAuthPage(oauthParams, templates, authActions);
  }
  const client = JSON.parse(clientRaw) as OAuthClient;

  const uriMatch = client.redirect_uris.some((registered) =>
    redirectUrisMatch(registered, redirectUri),
  );
  if (!uriMatch) {
    oauthParams.error = "Invalid redirect URI";
    return renderAuthPage(oauthParams, templates, authActions);
  }

  if (codeChallengeMethod !== "S256") {
    oauthParams.error = "code_challenge_method must be S256";
    return renderAuthPage(oauthParams, templates, authActions);
  }

  // Build action params from all non-OAuth fields
  const actionParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!OAUTH_FIELDS.has(key)) {
      actionParams[key] = value;
    }
  }

  let userId: number;

  if (mode === "signup") {
    const signupAction = api.actions.actions.find(
      (a: Action) => a.mcp?.isSignupAction,
    );
    if (!signupAction) {
      oauthParams.error = "No signup action configured";
      return renderAuthPage(oauthParams, templates, authActions);
    }
    const connection = new Connection("oauth", "oauth-signup");
    try {
      const { response, error } = await connection.act(
        signupAction.name,
        actionParams,
      );
      if (error) {
        oauthParams.error = error.message;
        return renderAuthPage(oauthParams, templates, authActions);
      }
      userId = (response as OAuthActionResponse).user.id;
    } finally {
      connection.destroy();
    }
  } else {
    const loginAction = api.actions.actions.find(
      (a: Action) => a.mcp?.isLoginAction,
    );
    if (!loginAction) {
      oauthParams.error = "No login action configured";
      return renderAuthPage(oauthParams, templates, authActions);
    }
    const connection = new Connection("oauth", "oauth-login");
    try {
      const { response, error } = await connection.act(
        loginAction.name,
        actionParams,
      );
      if (error) {
        oauthParams.error = error.message;
        return renderAuthPage(oauthParams, templates, authActions);
      }
      userId = (response as OAuthActionResponse).user.id;
    } finally {
      connection.destroy();
    }
  }

  // Generate auth code
  const code = randomUUID();
  const codeData: AuthCode = {
    clientId,
    userId,
    codeChallenge,
    redirectUri,
  };

  await api.redis.redis.set(
    `oauth:code:${code}`,
    JSON.stringify(codeData),
    "EX",
    config.server.mcp.oauthCodeTtl,
  );

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  return renderSuccessPage(redirectUrl.toString(), templates);
}

/** OAuth token exchange endpoint. */
export async function handleToken(req: Request): Promise<Response> {
  let body: URLSearchParams;
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    body = new URLSearchParams(text);
  } else if (contentType.includes("application/json")) {
    const json = await req.json();
    body = new URLSearchParams(json as Record<string, string>);
  } else {
    // Try form-urlencoded as default
    const text = await req.text();
    body = new URLSearchParams(text);
  }

  const grantType = body.get("grant_type");
  const code = body.get("code");
  const codeVerifier = body.get("code_verifier");
  const redirectUri = body.get("redirect_uri");
  const clientId = body.get("client_id");

  if (grantType !== "authorization_code") {
    return new Response(JSON.stringify({ error: "unsupported_grant_type" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!code || !codeVerifier) {
    return new Response(
      JSON.stringify({
        error: "invalid_request",
        error_description: "code and code_verifier are required",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Look up auth code
  const codeRaw = await api.redis.redis.get(`oauth:code:${code}`);
  if (!codeRaw) {
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "Invalid or expired authorization code",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const codeData = JSON.parse(codeRaw) as AuthCode;

  // Delete the code immediately (single use)
  await api.redis.redis.del(`oauth:code:${code}`);

  // Validate client_id matches
  if (clientId !== codeData.clientId) {
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "client_id mismatch",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Validate redirect_uri matches
  if (redirectUri && redirectUri !== codeData.redirectUri) {
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "redirect_uri mismatch",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Verify PKCE: BASE64URL(SHA256(code_verifier)) === stored code_challenge
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(codeVerifier),
  );
  const computedChallenge = base64UrlEncode(new Uint8Array(digest));

  if (computedChallenge !== codeData.codeChallenge) {
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "PKCE verification failed",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Generate access token
  const accessToken = randomUUID();
  const tokenData: TokenData = {
    userId: codeData.userId,
    clientId: codeData.clientId,
    scopes: [],
  };

  await api.redis.redis.set(
    `oauth:token:${accessToken}`,
    JSON.stringify(tokenData),
    "EX",
    config.session.ttl,
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: config.session.ttl,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
