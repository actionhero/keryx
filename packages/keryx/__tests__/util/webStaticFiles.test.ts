import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../api";
import { useTestServer } from "./../setup";

const getUrl = useTestServer();

const staticDir = config.server.web.staticFiles.directory;
const SECRET = `TRAVERSAL_SECRET_${crypto.randomUUID()}`;
let secretDir: string;

// Minimal but valid 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc000000003000100c9b301a00000000049454e44ae426082",
  "hex",
);

beforeAll(() => {
  secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "keryx-trav-"));
  fs.writeFileSync(path.join(secretDir, "secret.txt"), SECRET);

  if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, "ok.txt"), "legitimate content");
  fs.writeFileSync(path.join(staticDir, "cache-target.txt"), "cache me");
  fs.writeFileSync(path.join(staticDir, "styles.css"), "body { margin: 0 }");
  fs.writeFileSync(path.join(staticDir, "script.js"), "console.log('x')");
  fs.writeFileSync(path.join(staticDir, "data.json"), '{"ok":true}');
  fs.writeFileSync(path.join(staticDir, "image.png"), PNG_BYTES);
  fs.writeFileSync(
    path.join(staticDir, "weird.keryxunknown"),
    "unknown extension",
  );
  // Root index.html so `/` serves it (other test files may also create this;
  // writeFileSync is a full overwrite which is fine — content is compared below).
  fs.writeFileSync(path.join(staticDir, "index.html"), "<h1>root index</h1>");
  fs.mkdirSync(path.join(staticDir, "nested"), { recursive: true });
  fs.writeFileSync(
    path.join(staticDir, "nested", "file.txt"),
    "nested content",
  );
  // subdir/index.html for directory-fallback test
  fs.mkdirSync(path.join(staticDir, "wsfsubdir"), { recursive: true });
  fs.writeFileSync(
    path.join(staticDir, "wsfsubdir", "index.html"),
    "<h1>subdir index</h1>",
  );
  fs.symlinkSync(
    path.join(secretDir, "secret.txt"),
    path.join(staticDir, "evil-link.txt"),
  );
});

afterAll(() => {
  fs.rmSync(path.join(staticDir, "ok.txt"), { force: true });
  fs.rmSync(path.join(staticDir, "cache-target.txt"), { force: true });
  fs.rmSync(path.join(staticDir, "styles.css"), { force: true });
  fs.rmSync(path.join(staticDir, "script.js"), { force: true });
  fs.rmSync(path.join(staticDir, "data.json"), { force: true });
  fs.rmSync(path.join(staticDir, "image.png"), { force: true });
  fs.rmSync(path.join(staticDir, "weird.keryxunknown"), { force: true });
  // Don't remove index.html — other test files may rely on it.
  fs.rmSync(path.join(staticDir, "nested"), { recursive: true, force: true });
  fs.rmSync(path.join(staticDir, "wsfsubdir"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(staticDir, "evil-link.txt"), { force: true });
  fs.rmSync(secretDir, { recursive: true, force: true });
});

// Sends a raw HTTP/1.1 GET, bypassing the WHATWG URL normalization that
// `fetch` applies client-side. This is the only way to deliver literal
// `../`, `%2e%2e`, encoded slashes, and similar to the server un-normalized
// (though note: Bun.serve itself also normalizes some of these before the
// request reaches the fetch handler — see per-test comments).
async function rawGet(
  rawPath: string,
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(getUrl());
  const portNum = Number(port);
  let buf = "";
  let resolve: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  await Bun.connect({
    hostname,
    port: portNum,
    socket: {
      data(_socket, chunk) {
        buf += chunk.toString("latin1");
      },
      close() {
        resolve();
      },
      error() {
        resolve();
      },
      open(socket) {
        socket.write(
          `GET ${rawPath} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`,
        );
      },
    },
  });
  await done;
  const [head, ...rest] = buf.split("\r\n\r\n");
  const statusLine = head?.split("\r\n")[0] ?? "";
  const status = parseInt(statusLine.split(" ")[1] ?? "0", 10);
  return { status, body: rest.join("\r\n\r\n") };
}

describe("static file path traversal", () => {
  test("positive control: legitimate file serves", async () => {
    const res = await fetch(getUrl() + "/ok.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("legitimate content");
  });

  test("positive control: nested file serves", async () => {
    const res = await fetch(getUrl() + "/nested/file.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("nested content");
  });

  test("rejects literal ../ (raw socket)", async () => {
    const { status, body } = await rawGet("/../package.json");
    expect(status).toBe(404);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('"name": "keryx"');
  });

  test("rejects URL-encoded %2e%2e traversal (raw socket)", async () => {
    const { status, body } = await rawGet("/%2e%2e/package.json");
    expect(status).toBe(404);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('"name": "keryx"');
  });

  test("rejects mixed-encoding ..%2f traversal (raw socket)", async () => {
    const { status, body } = await rawGet("/..%2fpackage.json");
    expect(status).toBe(404);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('"name": "keryx"');
  });

  test("rejects double-encoded %252e%252e traversal", async () => {
    const res = await fetch(getUrl() + "/%252e%252e/package.json");
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('"name": "keryx"');
  });

  test("rejects encoded slash %2F..%2F traversal (raw socket)", async () => {
    const { status, body } = await rawGet("/%2F..%2Fpackage.json");
    expect(status).toBe(404);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('"name": "keryx"');
  });

  test("rejects absolute path /etc/passwd (raw socket)", async () => {
    const { status, body } = await rawGet("/etc/passwd");
    expect(status).toBe(404);
    expect(body).not.toContain("root:");
  });

  test("rejects double-slash //etc/passwd (raw socket)", async () => {
    const { status, body } = await rawGet("//etc/passwd");
    expect(status).toBe(404);
    expect(body).not.toContain("root:");
  });

  test("rejects Windows-style backslash ..\\..\\ traversal (raw socket)", async () => {
    const { status, body } = await rawGet("/..\\..\\package.json");
    expect(status).toBe(404);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('"name": "keryx"');
  });

  test("rejects null byte injection (raw socket)", async () => {
    const { status, body } = await rawGet("/ok.txt%00/../../package.json");
    // Even if a naive handler truncated at %00, it must not serve traversal.
    expect(body).not.toContain('"name": "keryx"');
    expect(body).not.toContain(SECRET);
    // Status depends on how %00 is handled; 200 serving ok.txt is acceptable,
    // but serving package.json or the secret file is not.
    expect([200, 400, 404]).toContain(status);
    if (status === 200) {
      expect(body).toContain("legitimate content");
    }
  });

  test("rejects symlink pointing outside staticDir", async () => {
    const res = await fetch(getUrl() + "/evil-link.txt");
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).not.toContain(SECRET);
  });
});

describe("static file MIME type detection", () => {
  test("serves .html as text/html", async () => {
    const res = await fetch(getUrl() + "/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  test("serves .css as text/css", async () => {
    const res = await fetch(getUrl() + "/styles.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
  });

  test("serves .js as a JavaScript type", async () => {
    const res = await fetch(getUrl() + "/script.js");
    expect(res.status).toBe(200);
    const ct = res.headers.get("Content-Type") ?? "";
    expect(ct).toMatch(/javascript/);
  });

  test("serves .json as application/json", async () => {
    const res = await fetch(getUrl() + "/data.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("serves .png as image/png", async () => {
    const res = await fetch(getUrl() + "/image.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/png");
  });

  test("falls back to application/octet-stream for unknown extensions", async () => {
    const res = await fetch(getUrl() + "/weird.keryxunknown");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });
});

describe("static file caching / conditional GETs", () => {
  test("emits ETag and Last-Modified when etag is enabled", async () => {
    if (!config.server.web.staticFiles.etag) return; // feature toggled off
    const res = await fetch(getUrl() + "/cache-target.txt");
    expect(res.status).toBe(200);
    const etag = res.headers.get("ETag");
    expect(etag).toBeDefined();
    expect(etag!.startsWith('"') && etag!.endsWith('"')).toBe(true);
    expect(res.headers.get("Last-Modified")).toBeDefined();
  });

  test("returns 304 when If-None-Match matches the current ETag", async () => {
    if (!config.server.web.staticFiles.etag) return;
    const first = await fetch(getUrl() + "/cache-target.txt");
    const etag = first.headers.get("ETag")!;
    const cond = await fetch(getUrl() + "/cache-target.txt", {
      headers: { "If-None-Match": etag },
    });
    expect(cond.status).toBe(304);
    expect(await cond.text()).toBe("");
  });

  test("returns 200 when If-None-Match does not match", async () => {
    if (!config.server.web.staticFiles.etag) return;
    const res = await fetch(getUrl() + "/cache-target.txt", {
      headers: { "If-None-Match": '"obviously-wrong-etag"' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cache me");
  });

  test("returns 304 when If-Modified-Since is >= mtime", async () => {
    if (!config.server.web.staticFiles.etag) return;
    // Send a date comfortably in the future — server should treat the resource
    // as unchanged since that point in time.
    const future = new Date(Date.now() + 60_000).toUTCString();
    const res = await fetch(getUrl() + "/cache-target.txt", {
      headers: { "If-Modified-Since": future },
    });
    expect(res.status).toBe(304);
  });

  test("returns 200 when If-Modified-Since is well in the past", async () => {
    if (!config.server.web.staticFiles.etag) return;
    const past = new Date(0).toUTCString();
    const res = await fetch(getUrl() + "/cache-target.txt", {
      headers: { "If-Modified-Since": past },
    });
    expect(res.status).toBe(200);
  });

  test("emits Cache-Control from config on static responses", async () => {
    const expected = config.server.web.staticFiles.cacheControl;
    if (!expected) return;
    const res = await fetch(getUrl() + "/cache-target.txt");
    expect(res.headers.get("Cache-Control")).toBe(expected);
  });
});

describe("static file directory fallback", () => {
  test("GET / serves the root index.html", async () => {
    const res = await fetch(getUrl() + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("root index");
  });

  test("GET /wsfsubdir/ serves wsfsubdir/index.html", async () => {
    const res = await fetch(getUrl() + "/wsfsubdir/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("subdir index");
  });
});

describe("static file security headers", () => {
  test("includes the configured security headers on static responses", async () => {
    const res = await fetch(getUrl() + "/ok.txt");
    expect(res.status).toBe(200);
    for (const [key, value] of Object.entries(
      config.server.web.securityHeaders,
    )) {
      if (!value) continue;
      expect(res.headers.get(key)).toBe(value);
    }
  });
});
