import { api } from "../api";
import { Initializer } from "../classes/Initializer";
import { config } from "../config";
import { checkRateLimit } from "../middleware/rateLimit";
import {
  appendHeaders,
  buildCorsHeaders,
  getExternalOrigin,
} from "../util/http";
import {
  handleAuthorizeGet,
  handleAuthorizePost,
  handleIntrospect,
  handleMetadata,
  handleProtectedResourceMetadata,
  handleRegister,
  handleRevoke,
  handleToken,
  OAUTH_PATHS,
  OAUTH_WELL_KNOWN_PATHS,
  type TokenData,
} from "../util/oauthHandlers";
import {
  loadOAuthTemplates,
  type OAuthTemplates,
} from "../util/oauthTemplates";

const namespace = "oauth";

declare module "keryx" {
  export interface API {
    [namespace]: Awaited<ReturnType<OAuthInitializer["initialize"]>>;
  }
}

export class OAuthInitializer extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["redis", "actions"];
  }

  async initialize() {
    const templates: OAuthTemplates = await loadOAuthTemplates(
      api.rootDir,
      api.packageDir,
    );

    async function verifyAccessToken(token: string): Promise<TokenData | null> {
      const raw = await api.redis.redis.get(`oauth:token:${token}`);
      if (!raw) return null;
      return JSON.parse(raw) as TokenData;
    }

    async function handleRequest(
      req: Request,
      ip?: string,
    ): Promise<Response | null> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method.toUpperCase();
      const origin = getExternalOrigin(req, url);
      const requestOrigin = req.headers.get("origin") ?? undefined;
      const corsHeaders = buildCorsHeaders(requestOrigin, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });

      // Handle CORS preflight for OAuth endpoints
      if (
        method === "OPTIONS" &&
        (path.startsWith("/.well-known/oauth") || path.startsWith("/oauth/"))
      ) {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const prmPrefix = OAUTH_WELL_KNOWN_PATHS.protectedResource;
      if (path.startsWith(prmPrefix) && method === "GET") {
        const resourcePath = path.slice(prmPrefix.length) || "";
        return appendHeaders(
          handleProtectedResourceMetadata(origin, resourcePath),
          corsHeaders,
        );
      }
      if (
        path === OAUTH_WELL_KNOWN_PATHS.authorizationServer &&
        method === "GET"
      ) {
        return appendHeaders(handleMetadata(origin), corsHeaders);
      }

      // Rate-limit mutable OAuth endpoints by IP
      if (
        config.rateLimit.enabled &&
        ip &&
        (path === OAUTH_PATHS.register ||
          path === OAUTH_PATHS.authorize ||
          path === OAUTH_PATHS.token ||
          path === OAUTH_PATHS.introspect ||
          path === OAUTH_PATHS.revoke)
      ) {
        // /oauth/register gets a stricter, dedicated rate limit
        const overrides =
          path === OAUTH_PATHS.register
            ? {
                limit: config.rateLimit.oauthRegisterLimit,
                windowMs: config.rateLimit.oauthRegisterWindowMs,
                keyPrefix: `${config.rateLimit.keyPrefix}:oauth-register`,
              }
            : undefined;
        const info = await checkRateLimit(`ip:${ip}`, false, overrides);
        if (info.retryAfter !== undefined) {
          return new Response(
            JSON.stringify({
              error: "rate_limit_exceeded",
              error_description: `Rate limit exceeded. Try again in ${info.retryAfter} seconds.`,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(info.retryAfter),
                "X-RateLimit-Limit": String(info.limit),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": String(info.resetAt),
              },
            },
          );
        }
      }

      if (path === OAUTH_PATHS.register && method === "POST") {
        return appendHeaders(await handleRegister(req), corsHeaders);
      }
      if (path === OAUTH_PATHS.authorize && method === "GET") {
        return handleAuthorizeGet(url, templates);
      }
      if (path === OAUTH_PATHS.authorize && method === "POST") {
        return handleAuthorizePost(req, templates);
      }
      if (path === OAUTH_PATHS.token && method === "POST") {
        return appendHeaders(await handleToken(req), corsHeaders);
      }
      if (path === OAUTH_PATHS.introspect && method === "POST") {
        return appendHeaders(await handleIntrospect(req), corsHeaders);
      }
      if (path === OAUTH_PATHS.revoke && method === "POST") {
        return appendHeaders(await handleRevoke(req), corsHeaders);
      }

      return null;
    }

    return {
      handleRequest,
      verifyAccessToken,
    };
  }
}
