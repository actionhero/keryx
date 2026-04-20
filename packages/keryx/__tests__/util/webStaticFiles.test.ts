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

beforeAll(() => {
  secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "keryx-trav-"));
  fs.writeFileSync(path.join(secretDir, "secret.txt"), SECRET);

  if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, "ok.txt"), "legitimate content");
  fs.mkdirSync(path.join(staticDir, "nested"), { recursive: true });
  fs.writeFileSync(
    path.join(staticDir, "nested", "file.txt"),
    "nested content",
  );
  fs.symlinkSync(
    path.join(secretDir, "secret.txt"),
    path.join(staticDir, "evil-link.txt"),
  );
});

afterAll(() => {
  fs.rmSync(path.join(staticDir, "ok.txt"), { force: true });
  fs.rmSync(path.join(staticDir, "nested"), { recursive: true, force: true });
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
