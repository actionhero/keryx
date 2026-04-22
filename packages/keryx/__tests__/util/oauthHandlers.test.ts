import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { api } from "../../api";
import { config } from "../../config";
import { base64UrlEncode } from "../../util/oauth";
import {
  handleAuthorizeGet,
  handleAuthorizePost,
  handleIntrospect,
  handleMetadata,
  handleProtectedResourceMetadata,
  handleRegister,
  handleRevoke,
  handleToken,
  type OAuthClient,
} from "../../util/oauthHandlers";
import {
  loadOAuthTemplates,
  type OAuthTemplates,
} from "../../util/oauthTemplates";
import { HOOK_TIMEOUT } from "../setup";

const packageDir = import.meta.dir + "/../..";
let templates: OAuthTemplates;

beforeAll(async () => {
  await api.start();
  await api.redis.redis.flushdb();
  templates = await loadOAuthTemplates(packageDir, packageDir);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

afterEach(async () => {
  // Clear rate limit keys so the web requests in this file don't trip them.
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

describe("handleProtectedResourceMetadata", () => {
  test("returns metadata with resource path appended", async () => {
    const res = handleProtectedResourceMetadata("https://example.com", "/mcp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    expect(body.resource).toBe("https://example.com/mcp");
    expect(body.authorization_servers).toEqual(["https://example.com"]);
    expect(body.scopes_supported).toEqual(["mcp"]);
  });

  test("returns origin as resource when resourcePath is empty", async () => {
    const res = handleProtectedResourceMetadata("https://example.com", "");
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe("https://example.com");
  });
});

describe("handleMetadata", () => {
  test("returns OAuth 2.1 server metadata with all documented fields", async () => {
    const res = handleMetadata("https://example.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe("https://example.com");
    expect(body.authorization_endpoint).toBe(
      "https://example.com/oauth/authorize",
    );
    expect(body.token_endpoint).toBe("https://example.com/oauth/token");
    expect(body.registration_endpoint).toBe(
      "https://example.com/oauth/register",
    );
    expect(body.introspection_endpoint).toBe(
      "https://example.com/oauth/introspect",
    );
    expect(body.revocation_endpoint).toBe("https://example.com/oauth/revoke");
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.introspection_endpoint_auth_methods_supported).toEqual([
      "none",
    ]);
    expect(body.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.client_id_metadata_document_supported).toBe(false);
  });
});

describe("handleRegister", () => {
  test("rejects a non-string entry in redirect_uris", async () => {
    const req = new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [123] }),
    });
    const res = await handleRegister(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_description: string };
    expect(body.error_description).toContain("string");
  });

  test("stores the new client in Redis with the configured TTL", async () => {
    const req = new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/cb"],
        client_name: "TTL Client",
      }),
    });
    const res = await handleRegister(req);
    expect(res.status).toBe(201);

    const { client_id } = (await res.json()) as OAuthClient;
    const ttl = await api.redis.redis.ttl(`oauth:client:${client_id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(config.server.mcp.oauthClientTtl);
  });

  test("applies sensible defaults for grant_types / response_types", async () => {
    const req = new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/cb"],
      }),
    });
    const res = await handleRegister(req);
    const body = (await res.json()) as OAuthClient;
    expect(body.grant_types).toEqual(["authorization_code"]);
    expect(body.response_types).toEqual(["code"]);
    expect(body.token_endpoint_auth_method).toBe("none");
  });
});

describe("handleToken — happy path", () => {
  test("exchanges a valid code + PKCE verifier for an access token", async () => {
    const clientId = `test-client-${crypto.randomUUID()}`;
    const redirectUri = "http://localhost:9999/cb";
    const codeVerifier = "test-verifier-correct-horse-battery-staple";
    const code = `code-${crypto.randomUUID()}`;

    // Seed the client
    await api.redis.redis.set(
      `oauth:client:${clientId}`,
      JSON.stringify({
        client_id: clientId,
        redirect_uris: [redirectUri],
      }),
      "EX",
      300,
    );

    // Seed a code with the correct SHA256 challenge
    const digest = createHash("sha256").update(codeVerifier).digest();
    const codeChallenge = base64UrlEncode(new Uint8Array(digest));
    await api.redis.redis.set(
      `oauth:code:${code}`,
      JSON.stringify({
        clientId,
        userId: 99,
        codeChallenge,
        redirectUri,
      }),
      "EX",
      300,
    );

    const req = new Request("http://localhost/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: clientId,
        redirect_uri: redirectUri,
      }).toString(),
    });
    const res = await handleToken(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body.access_token).toBeDefined();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(config.session.ttl);

    // Token stored in Redis with matching TokenData
    const stored = await api.redis.redis.get(
      `oauth:token:${body.access_token}`,
    );
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as {
      userId: number;
      clientId: string;
      scopes: string[];
    };
    expect(parsed.userId).toBe(99);
    expect(parsed.clientId).toBe(clientId);
    expect(parsed.scopes).toEqual([]);

    // Original code was consumed (single-use)
    expect(await api.redis.redis.get(`oauth:code:${code}`)).toBeNull();

    // Auth-code flow also mints a refresh token now
    const fullBody = parsed as unknown as { refreshToken?: string };
    expect(fullBody.refreshToken).toBeDefined();
    const refreshRaw = await api.redis.redis.get(
      `oauth:refresh:${fullBody.refreshToken}`,
    );
    expect(refreshRaw).not.toBeNull();
    const refreshData = JSON.parse(refreshRaw!) as {
      accessToken: string;
      clientId: string;
    };
    expect(refreshData.accessToken).toBe(body.access_token);
    expect(refreshData.clientId).toBe(clientId);
  });
});

describe("handleToken — refresh_token grant", () => {
  /** Seed a token pair directly, as `issueTokenPair` would produce. */
  async function seedPair(clientId: string, userId = 1, scopes: string[] = []) {
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

  function refreshRequest(fields: Record<string, string>): Request {
    return new Request("http://localhost/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        ...fields,
      }).toString(),
    });
  }

  test("rotates the pair: old tokens deleted, new tokens issued", async () => {
    const clientId = `client-${crypto.randomUUID()}`;
    const { accessToken, refreshToken } = await seedPair(clientId, 42, ["mcp"]);

    const res = await handleToken(
      refreshRequest({ refresh_token: refreshToken, client_id: clientId }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).not.toBe(accessToken);
    expect(body.refresh_token).not.toBe(refreshToken);

    // Old pair invalidated
    expect(await api.redis.redis.get(`oauth:token:${accessToken}`)).toBeNull();
    expect(
      await api.redis.redis.get(`oauth:refresh:${refreshToken}`),
    ).toBeNull();

    // New pair preserves scopes from the stored refresh record
    const newRefreshRaw = await api.redis.redis.get(
      `oauth:refresh:${body.refresh_token}`,
    );
    const newRefresh = JSON.parse(newRefreshRaw!) as { scopes: string[] };
    expect(newRefresh.scopes).toEqual(["mcp"]);
  });

  test("rejects unknown refresh token with invalid_grant", async () => {
    const res = await handleToken(
      refreshRequest({
        refresh_token: "never-existed",
        client_id: "some-client",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  test("rejects missing refresh_token with invalid_request", async () => {
    const res = await handleToken(refreshRequest({ client_id: "c" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("rejects refresh token with mismatched client_id", async () => {
    const { refreshToken } = await seedPair("owner-client");
    const res = await handleToken(
      refreshRequest({
        refresh_token: refreshToken,
        client_id: "attacker-client",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_description: string };
    expect(body.error_description).toContain("client_id mismatch");
  });
});

describe("handleIntrospect", () => {
  async function registerClient(): Promise<string> {
    const clientId = `intro-client-${crypto.randomUUID()}`;
    await api.redis.redis.set(
      `oauth:client:${clientId}`,
      JSON.stringify({
        client_id: clientId,
        redirect_uris: ["http://localhost:9999/cb"],
      }),
      "EX",
      300,
    );
    return clientId;
  }

  function introspectRequest(fields: Record<string, string>): Request {
    return new Request("http://localhost/oauth/introspect", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }

  test("active access token returns full metadata with Cache-Control no-store", async () => {
    const clientId = await registerClient();
    const token = `at-${crypto.randomUUID()}`;
    await api.redis.redis.set(
      `oauth:token:${token}`,
      JSON.stringify({ userId: 42, clientId, scopes: ["mcp"] }),
      "EX",
      300,
    );

    const res = await handleIntrospect(
      introspectRequest({ token, client_id: clientId }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
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

  test("refresh token is also introspectable when hint is passed", async () => {
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

    const res = await handleIntrospect(
      introspectRequest({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean; sub: string };
    expect(body.active).toBe(true);
    expect(body.sub).toBe("7");
  });

  test("unknown token returns active:false (no leak)", async () => {
    const clientId = await registerClient();
    const res = await handleIntrospect(
      introspectRequest({ token: "never-existed", client_id: clientId }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });

  test("missing client_id returns 401 invalid_client", async () => {
    const res = await handleIntrospect(
      introspectRequest({ token: "whatever" }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_client");
  });

  test("unknown client_id returns 401 invalid_client", async () => {
    const res = await handleIntrospect(
      introspectRequest({ token: "whatever", client_id: "never-registered" }),
    );
    expect(res.status).toBe(401);
  });

  test("missing token with valid client returns active:false", async () => {
    const clientId = await registerClient();
    const res = await handleIntrospect(
      introspectRequest({ client_id: clientId }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: boolean };
    expect(body.active).toBe(false);
  });
});

describe("handleRevoke", () => {
  async function seedPair(clientId: string) {
    const accessToken = `at-${crypto.randomUUID()}`;
    const refreshToken = `rt-${crypto.randomUUID()}`;
    await api.redis.redis.set(
      `oauth:token:${accessToken}`,
      JSON.stringify({ userId: 1, clientId, scopes: [], refreshToken }),
      "EX",
      300,
    );
    await api.redis.redis.set(
      `oauth:refresh:${refreshToken}`,
      JSON.stringify({ userId: 1, clientId, scopes: [], accessToken }),
      "EX",
      300,
    );
    return { accessToken, refreshToken };
  }

  function revokeRequest(fields: Record<string, string>): Request {
    return new Request("http://localhost/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }

  test("revoking an access token deletes both paired keys", async () => {
    const clientId = `rev-client-${crypto.randomUUID()}`;
    const { accessToken, refreshToken } = await seedPair(clientId);

    const res = await handleRevoke(
      revokeRequest({ token: accessToken, client_id: clientId }),
    );
    expect(res.status).toBe(200);
    expect(await api.redis.redis.get(`oauth:token:${accessToken}`)).toBeNull();
    expect(
      await api.redis.redis.get(`oauth:refresh:${refreshToken}`),
    ).toBeNull();
  });

  test("revoking a refresh token (with hint) deletes both paired keys", async () => {
    const clientId = `rev-client-${crypto.randomUUID()}`;
    const { accessToken, refreshToken } = await seedPair(clientId);

    const res = await handleRevoke(
      revokeRequest({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: clientId,
      }),
    );
    expect(res.status).toBe(200);
    expect(
      await api.redis.redis.get(`oauth:refresh:${refreshToken}`),
    ).toBeNull();
    expect(await api.redis.redis.get(`oauth:token:${accessToken}`)).toBeNull();
  });

  test("unknown token returns 200 (no leak)", async () => {
    const res = await handleRevoke(
      revokeRequest({ token: "nonexistent", client_id: "any" }),
    );
    expect(res.status).toBe(200);
  });

  test("client_id mismatch returns 200 and leaves the token alive", async () => {
    const clientId = `rev-client-${crypto.randomUUID()}`;
    const { accessToken, refreshToken } = await seedPair(clientId);

    const res = await handleRevoke(
      revokeRequest({ token: accessToken, client_id: "attacker-client" }),
    );
    expect(res.status).toBe(200);
    expect(
      await api.redis.redis.get(`oauth:token:${accessToken}`),
    ).not.toBeNull();
    expect(
      await api.redis.redis.get(`oauth:refresh:${refreshToken}`),
    ).not.toBeNull();
  });

  test("missing token returns 200", async () => {
    const res = await handleRevoke(revokeRequest({ client_id: "x" }));
    expect(res.status).toBe(200);
  });
});

describe("handleAuthorizeGet", () => {
  test("renders an HTML page for a GET request", () => {
    const url = new URL(
      "http://localhost/oauth/authorize?client_id=x&redirect_uri=y",
    );
    const res = handleAuthorizeGet(url, templates);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });
});

describe("handleAuthorizePost", () => {
  async function registerClient(
    redirectUri: string,
  ): Promise<{ clientId: string }> {
    const clientId = `test-client-${crypto.randomUUID()}`;
    await api.redis.redis.set(
      `oauth:client:${clientId}`,
      JSON.stringify({
        client_id: clientId,
        redirect_uris: [redirectUri],
      }),
      "EX",
      300,
    );
    return { clientId };
  }

  function buildPost(fields: Record<string, string>): Request {
    return new Request("http://localhost/oauth/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  }

  test("unknown client renders auth page with error", async () => {
    const res = await handleAuthorizePost(
      buildPost({
        client_id: "nonexistent-client",
        redirect_uri: "http://localhost:9999/cb",
        code_challenge: "chal",
        code_challenge_method: "S256",
        response_type: "code",
      }),
      templates,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Unknown client");
  });

  test("mismatched redirect_uri renders auth page with error", async () => {
    const { clientId } = await registerClient("http://localhost:9999/cb");
    const res = await handleAuthorizePost(
      buildPost({
        client_id: clientId,
        redirect_uri: "http://localhost:9999/different",
        code_challenge: "chal",
        code_challenge_method: "S256",
        response_type: "code",
      }),
      templates,
    );
    const html = await res.text();
    expect(html).toContain("Invalid redirect URI");
  });

  test("non-S256 code_challenge_method is rejected", async () => {
    const { clientId } = await registerClient("http://localhost:9999/cb");
    const res = await handleAuthorizePost(
      buildPost({
        client_id: clientId,
        redirect_uri: "http://localhost:9999/cb",
        code_challenge: "chal",
        code_challenge_method: "plain",
        response_type: "code",
      }),
      templates,
    );
    const html = await res.text();
    expect(html).toContain("S256");
  });

  test("missing login/signup action surfaces a friendly error", async () => {
    // The framework test suite has no user-defined actions, so
    // `api.actions.actions.find(a => a.mcp?.isLoginAction)` returns undefined.
    const { clientId } = await registerClient("http://localhost:9999/cb");
    const res = await handleAuthorizePost(
      buildPost({
        client_id: clientId,
        redirect_uri: "http://localhost:9999/cb",
        code_challenge: "chal",
        code_challenge_method: "S256",
        response_type: "code",
        // No mode => login path
      }),
      templates,
    );
    const html = await res.text();
    expect(html.toLowerCase()).toContain("no login action");
  });

  test("signup mode with no signup action registered surfaces an error", async () => {
    const { clientId } = await registerClient("http://localhost:9999/cb");
    const res = await handleAuthorizePost(
      buildPost({
        client_id: clientId,
        redirect_uri: "http://localhost:9999/cb",
        code_challenge: "chal",
        code_challenge_method: "S256",
        response_type: "code",
        mode: "signup",
      }),
      templates,
    );
    const html = await res.text();
    expect(html.toLowerCase()).toContain("no signup action");
  });

  test("malformed body returns 400", async () => {
    // Force the `req.formData()` path to throw by sending a broken multipart
    // content type without a boundary.
    const req = new Request("http://localhost/oauth/authorize", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data" },
      body: "not-actually-multipart",
    });
    const res = await handleAuthorizePost(req, templates);
    expect(res.status).toBe(400);
  });
});
