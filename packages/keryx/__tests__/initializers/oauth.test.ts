import { afterEach, describe, expect, test } from "bun:test";
import { api } from "../../api";
import { config } from "../../config";
import { useTestServer, waitFor } from "./../setup";

useTestServer({ clearRedis: true });

afterEach(async () => {
  // Clear rate limit keys to avoid 429s between tests
  let cursor = "0";
  do {
    const [next, keys] = await api.redis.redis.scan(
      cursor,
      "MATCH",
      `${config.rateLimit.keyPrefix}*`,
      "COUNT",
      100,
    );
    cursor = next;
    if (keys.length > 0) await api.redis.redis.del(...keys);
  } while (cursor !== "0");
});

/** Call the OAuth handler directly with a constructed Request. */
async function oauthRequest(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const url = `http://localhost${path}`;
  const req = new Request(url, init);
  return api.oauth.handleRequest(req, "127.0.0.1");
}

describe("oauth initializer", () => {
  test("oauth namespace is initialized", () => {
    expect(api.oauth).toBeDefined();
    expect(typeof api.oauth.handleRequest).toBe("function");
    expect(typeof api.oauth.verifyAccessToken).toBe("function");
  });

  describe("well-known endpoints", () => {
    test("protected resource metadata returns correct structure", async () => {
      const res = await oauthRequest("/.well-known/oauth-protected-resource", {
        method: "GET",
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);

      const body = (await res!.json()) as {
        resource: string;
        authorization_servers: string[];
        scopes_supported: string[];
      };
      expect(body.resource).toBeDefined();
      expect(body.authorization_servers).toBeArray();
      expect(body.authorization_servers.length).toBeGreaterThan(0);
      expect(body.scopes_supported).toEqual(["mcp"]);
    });

    test("authorization server metadata returns correct structure", async () => {
      const res = await oauthRequest(
        "/.well-known/oauth-authorization-server",
        { method: "GET" },
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);

      const body = (await res!.json()) as Record<string, unknown>;
      expect(body.issuer).toBeDefined();
      expect(body.authorization_endpoint).toContain("/oauth/authorize");
      expect(body.token_endpoint).toContain("/oauth/token");
      expect(body.registration_endpoint).toContain("/oauth/register");
      expect(body.introspection_endpoint).toContain("/oauth/introspect");
      expect(body.revocation_endpoint).toContain("/oauth/revoke");
      expect(body.response_types_supported).toEqual(["code"]);
      expect(body.grant_types_supported).toEqual([
        "authorization_code",
        "refresh_token",
      ]);
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(body.client_id_metadata_document_supported).toBe(false);
      expect(body.introspection_endpoint_auth_methods_supported).toEqual([
        "none",
      ]);
      expect(body.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
    });
  });

  describe("CORS preflight", () => {
    test("OPTIONS on OAuth endpoints returns 204", async () => {
      const res = await oauthRequest("/oauth/register", {
        method: "OPTIONS",
        headers: { Origin: "http://example.com" },
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(204);
    });
  });

  describe("client registration", () => {
    test("successful registration returns client with id", async () => {
      const res = await oauthRequest("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://localhost:9999/callback"],
          client_name: "Test Client",
        }),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(201);

      const body = (await res!.json()) as {
        client_id: string;
        redirect_uris: string[];
        client_name: string;
      };
      expect(body.client_id).toBeDefined();
      expect(body.redirect_uris).toEqual(["http://localhost:9999/callback"]);
      expect(body.client_name).toBe("Test Client");
    });

    test("registration stores client in Redis", async () => {
      const res = await oauthRequest("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://localhost:8888/callback"],
        }),
      });
      const body = (await res!.json()) as { client_id: string };

      const stored = await api.redis.redis.get(
        `oauth:client:${body.client_id}`,
      );
      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!) as { client_id: string };
      expect(parsed.client_id).toBe(body.client_id);
    });

    test("registration fails without redirect_uris", async () => {
      const res = await oauthRequest("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "No Redirects" }),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error: string };
      expect(body.error).toBe("invalid_request");
    });

    test("registration fails with empty redirect_uris array", async () => {
      const res = await oauthRequest("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [] }),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });

    test("registration fails with invalid redirect URI (non-HTTPS)", async () => {
      const res = await oauthRequest("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://external.com/callback"],
        }),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error_description: string };
      expect(body.error_description).toContain("HTTPS");
    });

    test("registration fails with invalid JSON body", async () => {
      const res = await oauthRequest("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });
  });

  describe("authorize GET", () => {
    test("returns HTML page with form fields", async () => {
      const params = new URLSearchParams({
        client_id: "test-client",
        redirect_uri: "http://localhost:9999/callback",
        code_challenge: "test-challenge",
        code_challenge_method: "S256",
        response_type: "code",
        state: "test-state",
      });
      const res = await oauthRequest(`/oauth/authorize?${params}`, {
        method: "GET",
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);

      const contentType = res!.headers.get("content-type");
      expect(contentType).toContain("text/html");

      const html = await res!.text();
      // The page renders with the Authorize Application heading.
      // Hidden fields with client params are only rendered inside the sign-in/sign-up
      // forms, which are conditionally shown based on whether login/signup actions are
      // registered. The example backend tests cover that field rendering end-to-end.
      expect(html).toContain("Authorize Application");
    });
  });

  describe("token endpoint errors", () => {
    test("rejects unsupported grant type", async () => {
      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
        }).toString(),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error: string };
      expect(body.error).toBe("unsupported_grant_type");
    });

    test("rejects missing code and code_verifier", async () => {
      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
        }).toString(),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error: string };
      expect(body.error).toBe("invalid_request");
    });

    test("rejects invalid authorization code", async () => {
      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "nonexistent-code",
          code_verifier: "test-verifier",
        }).toString(),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error: string };
      expect(body.error).toBe("invalid_grant");
    });

    test("rejects mismatched client_id", async () => {
      const codeData = {
        clientId: "original-client",
        userId: 1,
        codeChallenge: "test-challenge",
        redirectUri: "http://localhost:9999/callback",
      };
      await api.redis.redis.set(
        "oauth:code:test-code-client-mismatch",
        JSON.stringify(codeData),
        "EX",
        300,
      );

      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "test-code-client-mismatch",
          code_verifier: "test-verifier",
          client_id: "different-client",
        }).toString(),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error_description: string };
      expect(body.error_description).toContain("client_id mismatch");
    });

    test("rejects missing client_id", async () => {
      const codeData = {
        clientId: "original-client",
        userId: 1,
        codeChallenge: "test-challenge",
        redirectUri: "http://localhost:9999/callback",
      };
      await api.redis.redis.set(
        "oauth:code:test-code-client-missing",
        JSON.stringify(codeData),
        "EX",
        300,
      );

      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "test-code-client-missing",
          code_verifier: "test-verifier",
        }).toString(),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error_description: string };
      expect(body.error_description).toContain("client_id mismatch");
    });

    test("rejects mismatched redirect_uri", async () => {
      const codeData = {
        clientId: "test-client",
        userId: 1,
        codeChallenge: "test-challenge",
        redirectUri: "http://localhost:9999/callback",
      };
      await api.redis.redis.set(
        "oauth:code:test-code-redirect-mismatch",
        JSON.stringify(codeData),
        "EX",
        300,
      );

      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "test-code-redirect-mismatch",
          code_verifier: "test-verifier",
          client_id: "test-client",
          redirect_uri: "http://localhost:9999/different",
        }).toString(),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error_description: string };
      expect(body.error_description).toContain("redirect_uri mismatch");
    });

    test("rejects bad PKCE code_verifier", async () => {
      const codeData = {
        clientId: "test-client",
        userId: 1,
        codeChallenge: "correct-challenge-value",
        redirectUri: "http://localhost:9999/callback",
      };
      await api.redis.redis.set(
        "oauth:code:test-code-pkce",
        JSON.stringify(codeData),
        "EX",
        300,
      );

      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "test-code-pkce",
          code_verifier: "wrong-verifier",
          client_id: "test-client",
          redirect_uri: "http://localhost:9999/callback",
        }).toString(),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error_description: string };
      expect(body.error_description).toContain("PKCE verification failed");
    });

    test("rejects expired authorization code", async () => {
      // Set a code with a short TTL, then wait for Redis to evict it so the
      // token endpoint sees a truly expired (not merely absent) code.
      const codeData = {
        clientId: "test-client",
        userId: 1,
        codeChallenge: "test",
        redirectUri: "http://localhost:9999/callback",
      };
      await api.redis.redis.set(
        "oauth:code:expired-code",
        JSON.stringify(codeData),
        "PX",
        50,
      );
      await waitFor(
        async () =>
          (await api.redis.redis.get("oauth:code:expired-code")) === null,
      );

      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "expired-code",
          code_verifier: "whatever",
          client_id: "test-client",
        }).toString(),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as {
        error: string;
        error_description: string;
      };
      expect(body.error).toBe("invalid_grant");
      expect(body.error_description).toContain("Invalid or expired");
    });

    test("authorization codes are single-use", async () => {
      const codeData = {
        clientId: "test-client",
        userId: 1,
        codeChallenge: "test",
        redirectUri: "http://localhost:9999/callback",
      };
      await api.redis.redis.set(
        "oauth:code:single-use-code",
        JSON.stringify(codeData),
        "EX",
        300,
      );

      // First attempt (will fail PKCE but will consume the code)
      await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "single-use-code",
          code_verifier: "whatever",
          client_id: "test-client",
        }).toString(),
      });

      // Second attempt — code should be gone
      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "single-use-code",
          code_verifier: "whatever",
          client_id: "test-client",
        }).toString(),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error_description: string };
      expect(body.error_description).toContain("Invalid or expired");
    });

    test("accepts JSON content type for token exchange", async () => {
      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "nonexistent",
          code_verifier: "test",
        }),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);

      const body = (await res!.json()) as { error: string };
      expect(body.error).toBe("invalid_grant");
    });
  });

  describe("verifyAccessToken", () => {
    test("returns null for non-existent token", async () => {
      const result = await api.oauth.verifyAccessToken("nonexistent-token");
      expect(result).toBeNull();
    });

    test("returns token data for valid token", async () => {
      const tokenData = { userId: 42, clientId: "test-client", scopes: [] };
      await api.redis.redis.set(
        "oauth:token:test-token",
        JSON.stringify(tokenData),
        "EX",
        300,
      );

      const result = await api.oauth.verifyAccessToken("test-token");
      expect(result).toEqual(tokenData);
    });

    test("returns null for expired token", async () => {
      // Seed a token that expires almost immediately, then wait for Redis to
      // evict it. This proves the Redis TTL on `oauth:token:*` keys works
      // end-to-end — the MCP handler treats a null return as unauthenticated
      // and responds 401 with a WWW-Authenticate header (see `mcp.ts`).
      const tokenData = { userId: 7, clientId: "test-client", scopes: [] };
      await api.redis.redis.set(
        "oauth:token:expiring-token",
        JSON.stringify(tokenData),
        "PX",
        50,
      );

      // Sanity check: token is present before expiration
      const pre = await api.oauth.verifyAccessToken("expiring-token");
      expect(pre).toEqual(tokenData);

      await waitFor(
        async () =>
          (await api.redis.redis.get("oauth:token:expiring-token")) === null,
      );

      const post = await api.oauth.verifyAccessToken("expiring-token");
      expect(post).toBeNull();
    });
  });

  describe("handleRequest routing", () => {
    test("returns null for non-OAuth paths", async () => {
      const res = await oauthRequest("/api/status", { method: "GET" });
      expect(res).toBeNull();
    });
  });

  describe("refresh_token grant", () => {
    // Seed an access + refresh pair directly (bypassing the full auth-code flow),
    // matching the shape that `issueTokenPair` would produce.
    async function seedTokenPair(
      clientId: string,
      userId = 1,
      scopes: string[] = [],
    ) {
      const accessToken = `at-${crypto.randomUUID()}`;
      const refreshToken = `rt-${crypto.randomUUID()}`;
      await api.redis.redis.set(
        `oauth:token:${accessToken}`,
        JSON.stringify({ userId, clientId, scopes, refreshToken }),
        "EX",
        300,
      );
      await api.redis.redis.set(
        `oauth:refresh:${refreshToken}`,
        JSON.stringify({ userId, clientId, scopes, accessToken }),
        "EX",
        300,
      );
      return { accessToken, refreshToken };
    }

    test("issues new access+refresh pair and revokes the old pair", async () => {
      const { accessToken, refreshToken } = await seedTokenPair("test-client");

      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: "test-client",
        }).toString(),
      });
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);

      const body = (await res!.json()) as {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
      };
      expect(body.token_type).toBe("Bearer");
      expect(body.access_token).toBeDefined();
      expect(body.refresh_token).toBeDefined();
      expect(body.access_token).not.toBe(accessToken);
      expect(body.refresh_token).not.toBe(refreshToken);

      // Old pair is gone
      expect(
        await api.redis.redis.get(`oauth:refresh:${refreshToken}`),
      ).toBeNull();
      expect(
        await api.redis.redis.get(`oauth:token:${accessToken}`),
      ).toBeNull();

      // New pair is present
      expect(
        await api.redis.redis.get(`oauth:refresh:${body.refresh_token}`),
      ).not.toBeNull();
      expect(
        await api.redis.redis.get(`oauth:token:${body.access_token}`),
      ).not.toBeNull();
    });

    test("rejects unknown refresh token", async () => {
      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "nonexistent",
          client_id: "test-client",
        }).toString(),
      });
      expect(res!.status).toBe(400);
      const body = (await res!.json()) as { error: string };
      expect(body.error).toBe("invalid_grant");
    });

    test("rejects missing refresh_token", async () => {
      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "test-client",
        }).toString(),
      });
      expect(res!.status).toBe(400);
      const body = (await res!.json()) as { error: string };
      expect(body.error).toBe("invalid_request");
    });

    test("rejects refresh token with mismatched client_id", async () => {
      const { refreshToken } = await seedTokenPair("original-client");

      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: "different-client",
        }).toString(),
      });
      expect(res!.status).toBe(400);
      const body = (await res!.json()) as { error_description: string };
      expect(body.error_description).toContain("client_id mismatch");
    });

    test("rejects expired refresh token", async () => {
      await api.redis.redis.set(
        "oauth:refresh:expiring-refresh",
        JSON.stringify({
          userId: 1,
          clientId: "test-client",
          scopes: [],
          accessToken: "at-expiring",
        }),
        "PX",
        50,
      );
      await waitFor(
        async () =>
          (await api.redis.redis.get("oauth:refresh:expiring-refresh")) ===
          null,
      );

      const res = await oauthRequest("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "expiring-refresh",
          client_id: "test-client",
        }).toString(),
      });
      expect(res!.status).toBe(400);
      const body = (await res!.json()) as { error: string };
      expect(body.error).toBe("invalid_grant");
    });
  });

  describe("/oauth/revoke", () => {
    async function seedTokenPair(clientId: string) {
      const accessToken = `at-${crypto.randomUUID()}`;
      const refreshToken = `rt-${crypto.randomUUID()}`;
      await api.redis.redis.set(
        `oauth:token:${accessToken}`,
        JSON.stringify({
          userId: 1,
          clientId,
          scopes: [],
          refreshToken,
        }),
        "EX",
        300,
      );
      await api.redis.redis.set(
        `oauth:refresh:${refreshToken}`,
        JSON.stringify({
          userId: 1,
          clientId,
          scopes: [],
          accessToken,
        }),
        "EX",
        300,
      );
      return { accessToken, refreshToken };
    }

    test("revoking an access token deletes both paired keys", async () => {
      const { accessToken, refreshToken } = await seedTokenPair("test-client");

      const res = await oauthRequest("/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: accessToken,
          client_id: "test-client",
        }).toString(),
      });
      expect(res!.status).toBe(200);
      expect(
        await api.redis.redis.get(`oauth:token:${accessToken}`),
      ).toBeNull();
      expect(
        await api.redis.redis.get(`oauth:refresh:${refreshToken}`),
      ).toBeNull();
    });

    test("revoking a refresh token deletes both paired keys", async () => {
      const { accessToken, refreshToken } = await seedTokenPair("test-client");

      const res = await oauthRequest("/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: "refresh_token",
          client_id: "test-client",
        }).toString(),
      });
      expect(res!.status).toBe(200);
      expect(
        await api.redis.redis.get(`oauth:refresh:${refreshToken}`),
      ).toBeNull();
      expect(
        await api.redis.redis.get(`oauth:token:${accessToken}`),
      ).toBeNull();
    });

    test("returns 200 for unknown token (no leak)", async () => {
      const res = await oauthRequest("/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "nonexistent",
          client_id: "test-client",
        }).toString(),
      });
      expect(res!.status).toBe(200);
    });

    test("client_id mismatch leaves token intact and still returns 200", async () => {
      const { accessToken, refreshToken } = await seedTokenPair("owner-client");

      const res = await oauthRequest("/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: accessToken,
          client_id: "attacker-client",
        }).toString(),
      });
      expect(res!.status).toBe(200);
      expect(
        await api.redis.redis.get(`oauth:token:${accessToken}`),
      ).not.toBeNull();
      expect(
        await api.redis.redis.get(`oauth:refresh:${refreshToken}`),
      ).not.toBeNull();
    });
  });

  describe("/oauth/introspect", () => {
    async function registerClient(): Promise<string> {
      const res = await oauthRequest("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://localhost:9999/callback"],
        }),
      });
      const body = (await res!.json()) as { client_id: string };
      return body.client_id;
    }

    test("active access token returns full metadata", async () => {
      const clientId = await registerClient();
      const accessToken = `at-${crypto.randomUUID()}`;
      await api.redis.redis.set(
        `oauth:token:${accessToken}`,
        JSON.stringify({
          userId: 42,
          clientId,
          scopes: ["mcp"],
        }),
        "EX",
        300,
      );

      const res = await oauthRequest("/oauth/introspect", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: accessToken,
          client_id: clientId,
        }).toString(),
      });
      expect(res!.status).toBe(200);
      expect(res!.headers.get("cache-control")).toBe("no-store");

      const body = (await res!.json()) as {
        active: boolean;
        client_id: string;
        scope: string;
        token_type: string;
        exp: number;
        sub: string;
      };
      expect(body.active).toBe(true);
      expect(body.client_id).toBe(clientId);
      expect(body.scope).toBe("mcp");
      expect(body.token_type).toBe("Bearer");
      expect(body.sub).toBe("42");
      expect(body.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    test("active refresh token is also introspectable", async () => {
      const clientId = await registerClient();
      const refreshToken = `rt-${crypto.randomUUID()}`;
      await api.redis.redis.set(
        `oauth:refresh:${refreshToken}`,
        JSON.stringify({
          userId: 7,
          clientId,
          scopes: [],
          accessToken: "at-paired",
        }),
        "EX",
        300,
      );

      const res = await oauthRequest("/oauth/introspect", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: "refresh_token",
          client_id: clientId,
        }).toString(),
      });
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as {
        active: boolean;
        sub: string;
      };
      expect(body.active).toBe(true);
      expect(body.sub).toBe("7");
    });

    test("unknown token returns active:false", async () => {
      const clientId = await registerClient();
      const res = await oauthRequest("/oauth/introspect", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "never-existed",
          client_id: clientId,
        }).toString(),
      });
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as { active: boolean };
      expect(body.active).toBe(false);
    });

    test("expired token returns active:false", async () => {
      const clientId = await registerClient();
      await api.redis.redis.set(
        "oauth:token:introspect-expiring",
        JSON.stringify({ userId: 1, clientId, scopes: [] }),
        "PX",
        50,
      );
      await waitFor(
        async () =>
          (await api.redis.redis.get("oauth:token:introspect-expiring")) ===
          null,
      );

      const res = await oauthRequest("/oauth/introspect", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "introspect-expiring",
          client_id: clientId,
        }).toString(),
      });
      expect(res!.status).toBe(200);
      const body = (await res!.json()) as { active: boolean };
      expect(body.active).toBe(false);
    });

    test("unknown client_id returns 401", async () => {
      const res = await oauthRequest("/oauth/introspect", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: "whatever",
          client_id: "never-registered",
        }).toString(),
      });
      expect(res!.status).toBe(401);
      const body = (await res!.json()) as { error: string };
      expect(body.error).toBe("invalid_client");
    });

    test("missing client_id returns 401", async () => {
      const res = await oauthRequest("/oauth/introspect", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "whatever" }).toString(),
      });
      expect(res!.status).toBe(401);
    });
  });
});
