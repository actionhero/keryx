import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { api, logger } from "../../api";
import { config } from "../../config";
import { validateRedirectUri } from "../oauth";
import type { OAuthClient } from "./types";

/**
 * Client ID Metadata Documents (CIMD) — MCP 2026-07-28 / SEP-991, based on
 * `draft-ietf-oauth-client-id-metadata-document-00`.
 *
 * A client identifies itself with an HTTPS URL instead of a registered
 * `client_id`. The authorization server fetches that URL, validates the JSON
 * document it returns, and treats it as the client's registration for the
 * duration of the flow. Nothing is persisted, so CIMD client IDs are portable
 * across authorization servers and need no Dynamic Client Registration round
 * trip (which the 2026-07-28 revision deprecates).
 */

/** Redis key for a cached metadata document. */
const cimdKey = (url: string) => `oauth:cimd:${url}`;

/** Floor applied to a `Cache-Control: max-age` before it is used as a TTL. */
const MIN_CACHE_TTL = 60;

/** Upper bound on a `client_id` URL, since it becomes part of a Redis key. */
const MAX_CLIENT_ID_LENGTH = 2048;

/**
 * IPv4 ranges that are never a legitimate CIMD host. Fetching them would turn
 * the authorization server into an SSRF probe for its own private network
 * (Client ID Metadata Document draft §6, "Server Side Request Forgery").
 */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this host on this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata services)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

/** Parse a dotted-quad IPv4 address into a 32-bit unsigned integer. */
function ipv4ToInt(ip: string): number | null {
  const octets = ip.split(".");
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const byte = Number(octet);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

function isBlockedIpv4Int(value: number): boolean {
  for (const [network, prefix] of BLOCKED_IPV4_CIDRS) {
    const base = ipv4ToInt(network);
    if (base === null) continue;
    // `>>> 0` keeps the mask unsigned; a /0 would shift by 32 (a no-op in JS),
    // but no entry above uses one.
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) >>> 0 === (base & mask) >>> 0) return true;
  }
  return false;
}

/**
 * Expand an IPv6 literal into its 16 bytes. Handles `::` compression, an
 * embedded IPv4 tail (`::ffff:127.0.0.1`), and a trailing zone id.
 *
 * @param ip - The IPv6 literal, without surrounding brackets.
 * @returns The 16 address bytes, or `null` if the literal is unparseable.
 */
function ipv6Bytes(ip: string): Uint8Array | null {
  let text = ip.split("%")[0] ?? "";

  // Rewrite an embedded IPv4 tail as two hex groups so the rest of the parse
  // only has to deal with 16-bit groups.
  if (text.includes(".")) {
    const colon = text.lastIndexOf(":");
    if (colon === -1) return null;
    const v4 = text.slice(colon + 1);
    if (isIP(v4) !== 4) return null;
    const octets = v4.split(".").map(Number);
    const high = ((octets[0] as number) << 8) | (octets[1] as number);
    const low = ((octets[2] as number) << 8) | (octets[3] as number);
    text = `${text.slice(0, colon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const left = halves[0] ? (halves[0] as string).split(":") : [];
  const right = halves[1] ? (halves[1] as string).split(":") : [];
  const missing = 8 - left.length - right.length;
  if (compressed ? missing < 0 : missing !== 0) return null;

  const groups = [
    ...left,
    ...new Array<string>(compressed ? missing : 0).fill("0"),
    ...right,
  ];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i] as string;
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function isBlockedIpv6(bytes: Uint8Array): boolean {
  const v4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b;
  if (v4Mapped || nat64) {
    const embedded =
      ((bytes[12] as number) << 24) |
      ((bytes[13] as number) << 16) |
      ((bytes[14] as number) << 8) |
      (bytes[15] as number);
    return isBlockedIpv4Int(embedded >>> 0);
  }

  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return true; // ::1 loopback
  }
  if (((bytes[0] as number) & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && ((bytes[1] as number) & 0xc0) === 0x80) {
    return true; // fe80::/10 link-local
  }
  if (bytes[0] === 0xff) return true; // ff00::/8 multicast
  // 2001::/32 Teredo — tunnels to arbitrary IPv4 destinations, including private ones.
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return true;
  }
  return false;
}

/** True when a literal IP address (v4 or v6) must not be fetched. */
function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    return value === null ? true : isBlockedIpv4Int(value);
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    return bytes === null ? true : isBlockedIpv6(bytes);
  }
  return true;
}

/**
 * Resolve a hostname and confirm every address it maps to is publicly routable.
 *
 * A DNS name that resolves to a private address (a "DNS rebinding" style SSRF)
 * is rejected here, before any request is made. Note that this is a
 * check-then-fetch: a name whose records change between this lookup and the
 * fetch below could still land on a private address. Deployments that need a
 * hard guarantee should egress-filter the process rather than rely on this
 * check alone.
 *
 * @param hostname - Hostname from the `client_id` URL. IPv6 literals may arrive
 *   bracketed (as `URL.hostname` reports them) and are unwrapped here.
 * @returns `true` when the host is safe to fetch.
 */
async function isPubliclyRoutableHost(hostname: string): Promise<boolean> {
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

  if (isIP(host) !== 0) return !isBlockedAddress(host);

  let addresses: string[];
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    addresses = records.map((record) => record.address);
  } catch {
    return false;
  }
  if (addresses.length === 0) return false;
  return addresses.every((address) => !isBlockedAddress(address));
}

/**
 * True when a `client_id` should be resolved as a Client ID Metadata Document
 * rather than looked up as a registered client.
 *
 * Per the CIMD draft the identifier MUST be an `https:` URL with a path
 * component (e.g. `https://app.example.com/client.json`) and MUST NOT carry a
 * fragment. `http:` is additionally recognised when
 * `config.server.mcp.oauthCimdAllowPrivateHosts` is on, so a metadata document
 * served from `localhost` can be exercised in development.
 *
 * @param clientId - The raw `client_id` from the authorization request.
 * @returns `true` when {@link resolveClientIdMetadataDocument} should handle it.
 */
export function isClientIdMetadataDocumentUrl(clientId: string): boolean {
  // The identifier ends up in a Redis cache key, so cap it rather than letting
  // a caller choose the key length. Real metadata URLs are far shorter.
  if (clientId.length > MAX_CLIENT_ID_LENGTH) return false;

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }

  const httpAllowed = config.server.mcp.oauthCimdAllowPrivateHosts;
  if (url.protocol !== "https:" && !(httpAllowed && url.protocol === "http:")) {
    return false;
  }
  if (url.hash) return false;
  if (url.pathname === "" || url.pathname === "/") return false;
  return true;
}

/**
 * Validate a fetched metadata document and project it onto the framework's
 * client shape.
 *
 * @param clientId - The `client_id` URL the document was fetched from.
 * @param document - The parsed JSON body.
 * @returns The client, or the reason the document was rejected.
 */
function validateDocument(
  clientId: string,
  document: unknown,
): { client: OAuthClient } | { error: string } {
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    return { error: "Client metadata document is not a JSON object" };
  }
  const doc = document as Record<string, unknown>;

  // The draft requires an exact match so a document cannot claim an identity it
  // is not served from.
  if (doc.client_id !== clientId) {
    return { error: "Client metadata client_id does not match its URL" };
  }

  if (typeof doc.client_name !== "string" || doc.client_name.trim() === "") {
    return { error: "Client metadata document is missing client_name" };
  }

  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) {
    return { error: "Client metadata document is missing redirect_uris" };
  }
  for (const uri of doc.redirect_uris) {
    if (typeof uri !== "string") {
      return { error: "Client metadata redirect_uris must be strings" };
    }
    const validation = validateRedirectUri(uri);
    if (!validation.valid) {
      // `error` is always populated when `valid` is false; see oauth.ts
      return { error: validation.error as string };
    }
  }

  if (
    Array.isArray(doc.grant_types) &&
    !doc.grant_types.includes("authorization_code")
  ) {
    return {
      error: "Client metadata does not allow the authorization_code grant",
    };
  }
  if (
    Array.isArray(doc.response_types) &&
    !doc.response_types.includes("code")
  ) {
    return { error: "Client metadata does not allow the code response type" };
  }

  return {
    client: {
      client_id: clientId,
      redirect_uris: doc.redirect_uris as string[],
      client_name: doc.client_name,
      grant_types: (doc.grant_types as string[]) ?? ["authorization_code"],
      response_types: (doc.response_types as string[]) ?? ["code"],
      token_endpoint_auth_method:
        typeof doc.token_endpoint_auth_method === "string"
          ? doc.token_endpoint_auth_method
          : "none",
    },
  };
}

/** Read a response body, aborting once it exceeds `maxBytes`. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const reader = res.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Derive a cache TTL (seconds) from the document's HTTP cache headers, or
 * `null` when the response asks not to be stored.
 */
function cacheTtlFromHeaders(res: Response): number | null {
  const ceiling = config.server.mcp.oauthCimdCacheTtl;
  const cacheControl = (res.headers.get("cache-control") ?? "").toLowerCase();
  if (cacheControl.includes("no-store") || cacheControl.includes("no-cache")) {
    return null;
  }
  const maxAge = /max-age\s*=\s*(\d+)/.exec(cacheControl)?.[1];
  if (maxAge === undefined) return ceiling;
  const seconds = Number(maxAge);
  if (seconds <= 0) return null;
  return Math.min(Math.max(seconds, MIN_CACHE_TTL), ceiling);
}

/**
 * Resolve a URL-formatted `client_id` into a client by fetching and validating
 * its Client ID Metadata Document.
 *
 * Successful lookups are cached in Redis so a browser round trip through
 * `/oauth/authorize` (GET then POST) does not refetch the document, honouring
 * the origin's `Cache-Control` up to `config.server.mcp.oauthCimdCacheTtl`.
 * Failures are never cached.
 *
 * @param clientId - An HTTPS `client_id` URL, as accepted by
 *   {@link isClientIdMetadataDocumentUrl}.
 * @returns The resolved client, or a human-readable reason it was rejected. The
 *   reason is safe to render on the authorization page.
 */
export async function resolveClientIdMetadataDocument(
  clientId: string,
): Promise<{ client: OAuthClient } | { error: string }> {
  if (!config.server.mcp.oauthCimdEnabled) {
    return { error: "Client ID Metadata Documents are not supported" };
  }
  if (!isClientIdMetadataDocumentUrl(clientId)) {
    return { error: "Invalid client_id URL" };
  }

  const cached = await api.redis.redis.get(cimdKey(clientId));
  if (cached) return { client: JSON.parse(cached) as OAuthClient };

  const url = new URL(clientId);
  if (!config.server.mcp.oauthCimdAllowPrivateHosts) {
    if (!(await isPubliclyRoutableHost(url.hostname))) {
      return { error: "Client metadata host is not publicly routable" };
    }
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      // Do not follow redirects: a redirect could hop to a private address that
      // the pre-flight host check above never saw.
      redirect: "manual",
      signal: AbortSignal.timeout(config.server.mcp.oauthCimdFetchTimeoutMs),
    });
  } catch (error) {
    logger.debug(`CIMD fetch failed for ${clientId}: ${error}`);
    return { error: "Could not fetch the client metadata document" };
  }

  if (res.status !== 200) {
    await res.body?.cancel();
    return {
      error: `Client metadata document returned HTTP ${res.status}`,
    };
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) {
    await res.body?.cancel();
    return { error: "Client metadata document is not served as JSON" };
  }

  const text = await readCapped(res, config.server.mcp.oauthCimdMaxBytes);
  if (text === null) return { error: "Client metadata document is too large" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Client metadata document is not valid JSON" };
  }

  const result = validateDocument(clientId, parsed);
  if ("error" in result) return result;

  const ttl = cacheTtlFromHeaders(res);
  if (ttl !== null) {
    await api.redis.redis.set(
      cimdKey(clientId),
      JSON.stringify(result.client),
      "EX",
      ttl,
    );
  }

  return result;
}
