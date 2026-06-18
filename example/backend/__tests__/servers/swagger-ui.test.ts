import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import "../../index";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

beforeAll(async () => {
  await api.start();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("swagger UI", () => {
  test("GET / serves the Scalar API Reference HTML page", async () => {
    const res = await fetch(serverUrl() + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("@scalar/api-reference");
    expect(body).toContain("/api/swagger");
  });
});
