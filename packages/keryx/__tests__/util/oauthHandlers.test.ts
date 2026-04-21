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
  handleMetadata,
  handleProtectedResourceMetadata,
  handleRegister,
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
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.grant_types_supported).toEqual(["authorization_code"]);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
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
