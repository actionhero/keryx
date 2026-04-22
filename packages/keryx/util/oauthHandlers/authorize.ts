import { randomUUID } from "crypto";
import { api } from "../../api";
import type { Action, OAuthActionResponse } from "../../classes/Action";
import { Connection } from "../../classes/Connection";
import { config } from "../../config";
import { redirectUrisMatch } from "../oauth";
import {
  type AuthPageParams,
  type OAuthTemplates,
  renderAuthPage,
  renderSuccessPage,
} from "../oauthTemplates";
import { clientKey, codeKey } from "./keys";
import type { AuthCode, OAuthClient } from "./types";

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

function findAuthActions() {
  return {
    loginAction: api.actions.actions.find((a: Action) => a.mcp?.isLoginAction),
    signupAction: api.actions.actions.find(
      (a: Action) => a.mcp?.isSignupAction,
    ),
  };
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

  return renderAuthPage(params, templates, findAuthActions());
}

/**
 * Run the registered login or signup action inside an ephemeral OAuth
 * connection and return the authenticated user id. Returns an error string if
 * the action is not configured or the action itself returned an error.
 */
async function runAuthAction(
  mode: "signup" | "login",
  fields: Record<string, string>,
): Promise<{ userId: number } | { error: string }> {
  const isSignup = mode === "signup";
  const action = api.actions.actions.find((a: Action) =>
    isSignup ? a.mcp?.isSignupAction : a.mcp?.isLoginAction,
  );
  if (!action) {
    return {
      error: isSignup
        ? "No signup action configured"
        : "No login action configured",
    };
  }

  const actionParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!OAUTH_FIELDS.has(key)) actionParams[key] = value;
  }

  const connection = new Connection(
    "oauth",
    isSignup ? "oauth-signup" : "oauth-login",
  );
  try {
    const { response, error } = await connection.act(action.name, actionParams);
    if (error) return { error: error.message };
    return { userId: (response as OAuthActionResponse).user.id };
  } finally {
    connection.destroy();
  }
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

  const oauthParams: AuthPageParams = {
    clientId: fields.client_id ?? "",
    redirectUri: fields.redirect_uri ?? "",
    codeChallenge: fields.code_challenge ?? "",
    codeChallengeMethod: fields.code_challenge_method ?? "",
    responseType: fields.response_type ?? "",
    state: fields.state ?? "",
    error: "",
  };
  const authActions = findAuthActions();

  const renderError = (error: string) => {
    oauthParams.error = error;
    return renderAuthPage(oauthParams, templates, authActions);
  };

  const clientRaw = await api.redis.redis.get(clientKey(oauthParams.clientId));
  if (!clientRaw) return renderError("Unknown client");
  const client = JSON.parse(clientRaw) as OAuthClient;

  const uriMatch = client.redirect_uris.some((registered) =>
    redirectUrisMatch(registered, oauthParams.redirectUri),
  );
  if (!uriMatch) return renderError("Invalid redirect URI");

  if (oauthParams.codeChallengeMethod !== "S256") {
    return renderError("code_challenge_method must be S256");
  }

  const mode = fields.mode === "signup" ? "signup" : "login";
  const result = await runAuthAction(mode, fields);
  if ("error" in result) return renderError(result.error);

  const code = randomUUID();
  const codeData: AuthCode = {
    clientId: oauthParams.clientId,
    userId: result.userId,
    codeChallenge: oauthParams.codeChallenge,
    redirectUri: oauthParams.redirectUri,
  };

  await api.redis.redis.set(
    codeKey(code),
    JSON.stringify(codeData),
    "EX",
    config.server.mcp.oauthCodeTtl,
  );

  const redirectUrl = new URL(oauthParams.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (oauthParams.state)
    redirectUrl.searchParams.set("state", oauthParams.state);

  return renderSuccessPage(redirectUrl.toString(), templates);
}
