import { describe, expect, test } from "bun:test";
import { type ActionResponse } from "keryx";
import path from "path";
import type { FileUpload } from "../../actions/files";
import { useTestServer } from "./../setup";

const getUrl = useTestServer();

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
    const res = await fetch(getUrl() + "/api/file", {
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
