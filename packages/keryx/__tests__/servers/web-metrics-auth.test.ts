import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../../config";
import { useTestServer } from "../setup";

const originalEnabled = config.observability.enabled;
const originalUser = config.observability.metricsAuthUsername;
const originalPass = config.observability.metricsAuthPassword;

beforeAll(() => {
  config.observability.enabled = true;
});

const getUrl = useTestServer();

afterAll(() => {
  config.observability.enabled = originalEnabled;
  config.observability.metricsAuthUsername = originalUser;
  config.observability.metricsAuthPassword = originalPass;
});

describe("metrics endpoint auth", () => {
  describe("when no credentials are configured", () => {
    beforeAll(() => {
      config.observability.metricsAuthUsername = "";
      config.observability.metricsAuthPassword = "";
    });

    test("serves metrics without an Authorization header", async () => {
      const res = await fetch(getUrl() + "/metrics");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/plain");
    });
  });

  describe("when credentials are configured", () => {
    beforeAll(() => {
      config.observability.metricsAuthUsername = "admin";
      config.observability.metricsAuthPassword = "s3cret";
    });

    test("returns 401 with WWW-Authenticate when no Authorization header is sent", async () => {
      const res = await fetch(getUrl() + "/metrics");
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="Metrics"');
    });

    test("returns 401 when the Authorization scheme is not Basic", async () => {
      const res = await fetch(getUrl() + "/metrics", {
        headers: { Authorization: "Bearer some-token" },
      });
      expect(res.status).toBe(401);
    });

    test("returns 401 when the base64 payload is malformed", async () => {
      const res = await fetch(getUrl() + "/metrics", {
        headers: { Authorization: "Basic !!!not-base64!!!" },
      });
      expect(res.status).toBe(401);
    });

    test("returns 401 when the decoded credentials lack a colon", async () => {
      const res = await fetch(getUrl() + "/metrics", {
        headers: { Authorization: `Basic ${btoa("missing-colon")}` },
      });
      expect(res.status).toBe(401);
    });

    test("returns 401 with a wrong username", async () => {
      const res = await fetch(getUrl() + "/metrics", {
        headers: { Authorization: `Basic ${btoa("wrong:s3cret")}` },
      });
      expect(res.status).toBe(401);
    });

    test("returns 401 with a wrong password", async () => {
      const res = await fetch(getUrl() + "/metrics", {
        headers: { Authorization: `Basic ${btoa("admin:wrong")}` },
      });
      expect(res.status).toBe(401);
    });

    test("returns 200 with correct credentials", async () => {
      const res = await fetch(getUrl() + "/metrics", {
        headers: { Authorization: `Basic ${btoa("admin:s3cret")}` },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
    });

    test("supports passwords containing colons", async () => {
      const original = config.observability.metricsAuthPassword;
      config.observability.metricsAuthPassword = "pass:with:colons";
      try {
        const res = await fetch(getUrl() + "/metrics", {
          headers: {
            Authorization: `Basic ${btoa("admin:pass:with:colons")}`,
          },
        });
        expect(res.status).toBe(200);
      } finally {
        config.observability.metricsAuthPassword = original;
      }
    });
  });
});
