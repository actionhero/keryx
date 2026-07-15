export type OAuthClient = {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  /**
   * OpenID Connect `application_type` (`"web"` | `"native"`), declared at
   * registration per MCP 2026-07-28 / SEP-837 so the authorization server does
   * not misclassify native/CLI clients as web clients. Defaults to `"web"`.
   */
  application_type?: "web" | "native";
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
  refreshToken?: string;
};

export type RefreshTokenData = {
  userId: number;
  clientId: string;
  scopes: string[];
  accessToken: string;
};

/** Route paths for the OAuth endpoints served by this framework. */
export const OAUTH_PATHS = {
  register: "/oauth/register",
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  introspect: "/oauth/introspect",
  revoke: "/oauth/revoke",
} as const;

/** Well-known metadata paths (RFC 8414 + RFC 9728). */
export const OAUTH_WELL_KNOWN_PATHS = {
  authorizationServer: "/.well-known/oauth-authorization-server",
  protectedResource: "/.well-known/oauth-protected-resource",
} as const;
