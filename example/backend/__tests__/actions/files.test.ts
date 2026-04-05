import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api } from "keryx";
import path from "path";
import type { FileUpload } from "../../actions/files";
import { HOOK_TIMEOUT, serverUrl } from "./../setup";

let url: string;

beforeAll(async () => {
  await api.start();
  url = serverUrl();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("status", () => {
  test("the web server can handle a request to an action", async () => {
    const formData = new FormData();
    formData.append("stringParam", "test");
    const filePath = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "frontend",
      "public",
      "images",
      "horn.svg",
    );

    const f = Bun.file(filePath);
    formData.append("file", f);
    const res = await fetch(url + "/api/file", {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(200);
    const response = (await res.json()) as ActionResponse<FileUpload>;
    expect(response.params.stringParam).toBe("test");
    expect(response.params.file.name).toInclude("/horn.svg");
    expect(response.params.file.type).toBe("image/svg+xml");
    expect(response.params.file.size).toBe(f.size);
  });
});
