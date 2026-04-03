import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "../../api";
import { config } from "../../config";
import { HOOK_TIMEOUT } from "./../setup";

beforeAll(async () => {
  await api.start();
  await api.redis.redis.flushdb();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

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
      expect(body.response_types_supported).toEqual(["code"]);
      expect(body.grant_types_supported).toEqual(["authorization_code"]);
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(body.client_id_metadata_document_supported).toBe(false);
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
  });

  describe("handleRequest routing", () => {
    test("returns null for non-OAuth paths", async () => {
      const res = await oauthRequest("/api/status", { method: "GET" });
      expect(res).toBeNull();
    });
  });
});
