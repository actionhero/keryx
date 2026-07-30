import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "../../api";
import { config } from "../../config";
import {
  isClientIdMetadataDocumentUrl,
  resolveClientIdMetadataDocument,
} from "../../util/oauthHandlers";
import { HOOK_TIMEOUT } from "../setup";

/**
 * Client ID Metadata Documents (MCP 2026-07-28 / SEP-991).
 *
 * The documents under test are served by a real HTTP server on loopback, so
 * `oauthCimdAllowPrivateHosts` is enabled for most of this file. The SSRF suite
 * turns it back off — that guard is exactly what it is testing.
 */

/** What the test origin should return for the next request to a given path. */
type Route = (req: Request) => Response;

let server: ReturnType<typeof Bun.serve>;
let origin: string;
const routes = new Map<string, Route>();
const hits = new Map<string, number>();
const originalCimdConfig = { ...config.server.mcp };

beforeAll(async () => {
  await api.start();
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      const route = routes.get(path);
      if (!route) return new Response("not found", { status: 404 });
      return route(req);
    },
  });
  origin = `http://localhost:${server.port}`;
}, HOOK_TIMEOUT);

afterAll(async () => {
  server.stop(true);
  Object.assign(config.server.mcp, originalCimdConfig);
  await api.stop();
}, HOOK_TIMEOUT);

beforeEach(async () => {
  routes.clear();
  hits.clear();
  config.server.mcp.oauthCimdEnabled = true;
  config.server.mcp.oauthCimdAllowPrivateHosts = true;
  config.server.mcp.oauthCimdMaxBytes = 64 * 1024;
  config.server.mcp.oauthCimdFetchTimeoutMs =
    originalCimdConfig.oauthCimdFetchTimeoutMs;
  // Cached documents would mask fetch behaviour between tests.
  const keys = await api.redis.redis.keys("oauth:cimd:*");
  if (keys.length > 0) await api.redis.redis.del(...keys);
});

/** Serve `body` as a metadata document at `path` and return its client_id URL. */
function serveDocument(
  path: string,
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): string {
  const clientId = `${origin}${path}`;
  routes.set(
    path,
    () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      }),
  );
  return clientId;
}

/** A valid document for `clientId`, optionally with overrides. */
function validDocument(
  clientId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    client_id: clientId,
    client_name: "Example MCP Client",
    redirect_uris: ["http://localhost:3000/callback"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...overrides,
  };
}

describe("isClientIdMetadataDocumentUrl", () => {
  test("accepts an https URL with a path component", () => {
    expect(
      isClientIdMetadataDocumentUrl("https://app.example.com/client.json"),
    ).toBe(true);
  });

  test("rejects an https URL with no path component", () => {
    expect(isClientIdMetadataDocumentUrl("https://app.example.com")).toBe(
      false,
    );
    expect(isClientIdMetadataDocumentUrl("https://app.example.com/")).toBe(
      false,
    );
  });

  test("rejects a URL carrying a fragment", () => {
    expect(
      isClientIdMetadataDocumentUrl("https://app.example.com/c.json#frag"),
    ).toBe(false);
  });

  test("rejects opaque client ids so registered clients still resolve", () => {
    expect(isClientIdMetadataDocumentUrl("")).toBe(false);
    expect(isClientIdMetadataDocumentUrl("not-a-url")).toBe(false);
    expect(
      isClientIdMetadataDocumentUrl("3f6b1c8e-0000-4000-8000-000000000000"),
    ).toBe(false);
  });

  test("rejects an absurdly long URL", () => {
    const long = `https://app.example.com/${"a".repeat(4000)}.json`;
    expect(isClientIdMetadataDocumentUrl(long)).toBe(false);
  });

  test("recognises http only when private hosts are allowed", () => {
    config.server.mcp.oauthCimdAllowPrivateHosts = false;
    expect(isClientIdMetadataDocumentUrl("http://localhost:3000/c.json")).toBe(
      false,
    );
    config.server.mcp.oauthCimdAllowPrivateHosts = true;
    expect(isClientIdMetadataDocumentUrl("http://localhost:3000/c.json")).toBe(
      true,
    );
  });
});

describe("resolveClientIdMetadataDocument — happy path", () => {
  test("resolves a valid document into a client", async () => {
    const clientId = `${origin}/client.json`;
    serveDocument("/client.json", validDocument(clientId));

    const result = await resolveClientIdMetadataDocument(clientId);
    expect(result).not.toHaveProperty("error");
    if ("error" in result) throw new Error(result.error);

    expect(result.client.client_id).toBe(clientId);
    expect(result.client.client_name).toBe("Example MCP Client");
    expect(result.client.redirect_uris).toEqual([
      "http://localhost:3000/callback",
    ]);
    expect(result.client.token_endpoint_auth_method).toBe("none");
  });

  test("defaults grant_types and response_types when omitted", async () => {
    const clientId = `${origin}/minimal.json`;
    serveDocument("/minimal.json", {
      client_id: clientId,
      client_name: "Minimal",
      redirect_uris: ["https://app.example.com/cb"],
    });

    const result = await resolveClientIdMetadataDocument(clientId);
    if ("error" in result) throw new Error(result.error);
    expect(result.client.grant_types).toEqual(["authorization_code"]);
    expect(result.client.response_types).toEqual(["code"]);
  });

  test("reads a chunked response with no content-length", async () => {
    const clientId = `${origin}/chunked.json`;
    const body = JSON.stringify(validDocument(clientId));
    routes.set("/chunked.json", () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(body);
          controller.enqueue(bytes.slice(0, 10));
          controller.enqueue(bytes.slice(10));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await resolveClientIdMetadataDocument(clientId);
    if ("error" in result) throw new Error(result.error);
    expect(result.client.client_name).toBe("Example MCP Client");
  });
});

describe("resolveClientIdMetadataDocument — caching", () => {
  test("caches a resolved document instead of refetching", async () => {
    const clientId = `${origin}/cached.json`;
    serveDocument("/cached.json", validDocument(clientId));

    await resolveClientIdMetadataDocument(clientId);
    await resolveClientIdMetadataDocument(clientId);
    expect(hits.get("/cached.json")).toBe(1);
  });

  test("honours Cache-Control: no-store", async () => {
    const clientId = `${origin}/nostore.json`;
    serveDocument("/nostore.json", validDocument(clientId), {
      headers: { "Cache-Control": "no-store" },
    });

    await resolveClientIdMetadataDocument(clientId);
    await resolveClientIdMetadataDocument(clientId);
    expect(hits.get("/nostore.json")).toBe(2);
  });

  test("does not cache a rejected document", async () => {
    const clientId = `${origin}/bad.json`;
    serveDocument("/bad.json", { client_id: "https://elsewhere.test/c.json" });

    expect(await resolveClientIdMetadataDocument(clientId)).toHaveProperty(
      "error",
    );
    expect(await resolveClientIdMetadataDocument(clientId)).toHaveProperty(
      "error",
    );
    expect(hits.get("/bad.json")).toBe(2);
  });
});

describe("resolveClientIdMetadataDocument — validation", () => {
  test("rejects a document whose client_id does not match its URL", async () => {
    const clientId = `${origin}/mismatch.json`;
    serveDocument(
      "/mismatch.json",
      validDocument("https://attacker.test/other.json"),
    );

    const result = await resolveClientIdMetadataDocument(clientId);
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toContain("does not match its URL");
  });

  test("rejects a document missing client_name", async () => {
    const clientId = `${origin}/noname.json`;
    const doc = validDocument(clientId);
    delete doc.client_name;
    serveDocument("/noname.json", doc);

    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("client_name");
  });

  test("rejects a document missing redirect_uris", async () => {
    const clientId = `${origin}/nouris.json`;
    serveDocument(
      "/nouris.json",
      validDocument(clientId, { redirect_uris: [] }),
    );

    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("redirect_uris");
  });

  test("rejects a dangerous redirect_uri scheme", async () => {
    const clientId = `${origin}/xss.json`;
    serveDocument(
      "/xss.json",
      validDocument(clientId, { redirect_uris: ["javascript:alert(1)"] }),
    );

    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("not allowed");
  });

  test("rejects a document that disallows the authorization_code grant", async () => {
    const clientId = `${origin}/nogrant.json`;
    serveDocument(
      "/nogrant.json",
      validDocument(clientId, { grant_types: ["client_credentials"] }),
    );

    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("authorization_code");
  });

  test("rejects a JSON array", async () => {
    const clientId = `${origin}/array.json`;
    serveDocument("/array.json", []);
    expect(await resolveClientIdMetadataDocument(clientId)).toHaveProperty(
      "error",
    );
  });

  test("rejects a body that is not valid JSON", async () => {
    const clientId = `${origin}/broken.json`;
    serveDocument("/broken.json", "{not json");

    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("not valid JSON");
  });
});

describe("resolveClientIdMetadataDocument — transport", () => {
  test("rejects a non-200 response", async () => {
    const clientId = `${origin}/missing.json`;
    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("HTTP 404");
  });

  test("rejects a non-JSON content type", async () => {
    const clientId = `${origin}/html.json`;
    routes.set(
      "/html.json",
      () =>
        new Response("<html></html>", {
          headers: { "Content-Type": "text/html" },
        }),
    );

    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("not served as JSON");
  });

  test("does not follow a redirect", async () => {
    const clientId = `${origin}/redirect.json`;
    serveDocument("/target.json", validDocument(clientId));
    routes.set(
      "/redirect.json",
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: `${origin}/target.json` },
        }),
    );

    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("HTTP 302");
    expect(hits.has("/target.json")).toBe(false);
  });

  test("rejects a document larger than the byte cap", async () => {
    config.server.mcp.oauthCimdMaxBytes = 32;
    const clientId = `${origin}/big.json`;
    serveDocument("/big.json", validDocument(clientId));

    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("too large");
  });

  test("caps a chunked body with no declared length", async () => {
    config.server.mcp.oauthCimdMaxBytes = 32;
    const clientId = `${origin}/bigchunked.json`;
    routes.set("/bigchunked.json", () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 10; i++) {
            controller.enqueue(new TextEncoder().encode("x".repeat(16)));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("too large");
  });
});

describe("resolveClientIdMetadataDocument — SSRF guard", () => {
  beforeEach(() => {
    config.server.mcp.oauthCimdAllowPrivateHosts = false;
  });

  const privateTargets = [
    "https://localhost/client.json",
    "https://127.0.0.1/client.json",
    "https://[::1]/client.json",
    "https://10.1.2.3/client.json",
    "https://192.168.1.1/client.json",
    "https://172.16.0.1/client.json",
    // AWS/GCP/Azure instance metadata service.
    "https://169.254.169.254/latest/meta-data.json",
    // IPv4-mapped IPv6 loopback.
    "https://[::ffff:127.0.0.1]/client.json",
    // Unique-local IPv6.
    "https://[fd00::1]/client.json",
    // Link-local IPv6.
    "https://[fe80::1]/client.json",
  ];

  for (const target of privateTargets) {
    test(`refuses to fetch ${target}`, async () => {
      const result = await resolveClientIdMetadataDocument(target);
      if (!("error" in result)) throw new Error("expected rejection");
      expect(result.error).toContain("not publicly routable");
    });
  }

  test("does not blanket-block publicly routable addresses", async () => {
    // A public literal address clears the guard, so whatever failure comes back
    // is the fetch's (unreachable host / TLS), never the guard's. This proves
    // the check is a filter rather than a blanket deny.
    config.server.mcp.oauthCimdFetchTimeoutMs = 1000;
    const result = await resolveClientIdMetadataDocument(
      "https://93.184.216.34/client.json",
    );
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).not.toContain("not publicly routable");
  }, 20_000);
});

describe("resolveClientIdMetadataDocument — disabled", () => {
  test("refuses to resolve when CIMD is turned off", async () => {
    config.server.mcp.oauthCimdEnabled = false;
    const clientId = `${origin}/client.json`;
    serveDocument("/client.json", validDocument(clientId));

    const result = await resolveClientIdMetadataDocument(clientId);
    if (!("error" in result)) throw new Error("expected rejection");
    expect(result.error).toContain("not supported");
    expect(hits.has("/client.json")).toBe(false);
  });
});
