import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Action,
  type ActionMiddleware,
  api,
  CONNECTION_TYPE,
  Connection,
  HTTP_METHOD,
} from "keryx";
import { config } from "keryx/config";
import { z } from "zod";
import { csrfPlugin } from "../index";
import { CsrfMiddleware } from "../middleware/csrf";
import { ensureToken, getToken } from "../util/token";
import { HOOK_TIMEOUT, serverUrl } from "./setup";

class CsrfPutEcho implements Action {
  name = "csrf:test:put";
  description = "Test action protected by CsrfMiddleware (PUT)";
  inputs = z.object({
    payload: z.string().optional(),
    csrfToken: z.string().optional(),
  });
  web = { route: "/csrf-test/put", method: HTTP_METHOD.PUT };
  mcp = { tool: false };
  middleware = [CsrfMiddleware];
  async run(params: { payload?: string }) {
    return { ok: true, payload: params.payload ?? null };
  }
}

function getSessionCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookieName = config.session.cookieName;
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) throw new Error("session cookie not set on response");
  return `${cookieName}=${match[1]}`;
}

async function fetchToken(
  cookie?: string,
): Promise<{ token: string; expiresAt: number; cookie: string }> {
  const res = await fetch(`${serverUrl()}/api/csrf-token`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; expiresAt: number };
  const finalCookie = cookie ?? getSessionCookie(res);
  return { ...body, cookie: finalCookie };
}

describe("csrf plugin", () => {
  beforeAll(async () => {
    config.plugins.push(csrfPlugin());
    await api.start();
    api.actions.actions.push(new CsrfPutEcho());
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    api.actions.actions = api.actions.actions.filter(
      (a: Action) => !a.name.startsWith("csrf:test:"),
    );
    await api.stop();
  }, HOOK_TIMEOUT);

  describe("/csrf-token", () => {
    test("returns a token and sets a session cookie", async () => {
      const res = await fetch(`${serverUrl()}/api/csrf-token`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; expiresAt: number };
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThan(20);
      expect(typeof body.expiresAt).toBe("number");
      expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(res.headers.get("set-cookie") ?? "").toContain(
        config.session.cookieName,
      );
    });

    test("returns the same token on a second call with the same session", async () => {
      const first = await fetchToken();
      const second = await fetchToken(first.cookie);
      expect(second.token).toBe(first.token);
    });

    test("stores the token in Redis with a positive TTL", async () => {
      const first = await fetchToken();
      // Reach into Redis via the same session id used internally
      const cookieValue = first.cookie.split("=")[1];
      const ttl = await api.redis.redis.ttl(`csrf:token:${cookieValue}`);
      expect(ttl).toBeGreaterThan(0);
    });

    test("csrfPlugin({ tokenActionMiddleware }) wires guards onto the action", () => {
      const guard: ActionMiddleware = { runBefore: async () => {} };
      const plugin = csrfPlugin({ tokenActionMiddleware: [guard] });
      const ActionClass = plugin.actions![0];
      const instance = new ActionClass();
      expect(instance.middleware).toEqual([guard]);
      expect(instance.name).toBe("csrf:token");
    });
  });

  describe("CsrfMiddleware", () => {
    test("rejects a state-changing request with no token (403)", async () => {
      const { cookie } = await fetchToken();
      const res = await fetch(`${serverUrl()}/api/csrf-test/put`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ payload: "hi" }),
      });
      expect(res.status).toBe(403);
    });

    test("rejects a request with the wrong token (403)", async () => {
      const { cookie } = await fetchToken();
      const res = await fetch(`${serverUrl()}/api/csrf-test/put`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ payload: "hi", csrfToken: "definitely-wrong" }),
      });
      expect(res.status).toBe(403);
    });

    test("accepts a request with the correct token in the JSON body", async () => {
      const { token, cookie } = await fetchToken();
      const res = await fetch(`${serverUrl()}/api/csrf-test/put`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ payload: "hello", csrfToken: token }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; payload: string };
      expect(body).toEqual({ ok: true, payload: "hello" });
    });

    test("accepts a form-encoded request with the token as a form field", async () => {
      const { token, cookie } = await fetchToken();
      const form = new URLSearchParams();
      form.set("payload", "form");
      form.set("csrfToken", token);
      const res = await fetch(`${serverUrl()}/api/csrf-test/put`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookie,
        },
        body: form.toString(),
      });
      expect(res.status).toBe(200);
    });

    test("accepts the token as a query string parameter", async () => {
      const { token, cookie } = await fetchToken();
      const res = await fetch(
        `${serverUrl()}/api/csrf-test/put?csrfToken=${token}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ payload: "via-query" }),
        },
      );
      expect(res.status).toBe(200);
    });

    test("a token issued for session A does not validate for session B", async () => {
      const a = await fetchToken();
      const b = await fetchToken();
      expect(a.cookie).not.toBe(b.cookie);
      const res = await fetch(`${serverUrl()}/api/csrf-test/put`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: b.cookie },
        body: JSON.stringify({ payload: "x", csrfToken: a.token }),
      });
      expect(res.status).toBe(403);
    });

    test("regenerating the session invalidates the previous token", async () => {
      // Issue a token bound to the old session id, then regenerate the session.
      // The new session id has no token in Redis, so any check using the old
      // token against the new session fails.
      const conn = new Connection(CONNECTION_TYPE.WEB, "127.0.0.1");
      await conn.loadSession();
      const oldId = conn.sessionId;
      const issued = await ensureToken(oldId);

      await conn.regenerateSession();
      expect(conn.sessionId).not.toBe(oldId);

      const tokenForNewSession = await getToken(conn.sessionId);
      expect(tokenForNewSession).toBeNull();
      expect(tokenForNewSession).not.toBe(issued.token);

      conn.destroy();
    });
  });
});
