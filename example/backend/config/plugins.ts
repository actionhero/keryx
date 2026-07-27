import { csrfPlugin } from "@keryxjs/csrf";
import { tracingPlugin } from "@keryxjs/tracing";
import type { KeryxPlugin } from "keryx";
import { SessionMiddleware } from "../middleware/session";

export default {
  plugins: [
    tracingPlugin,
    csrfPlugin({ tokenActionMiddleware: [SessionMiddleware] }),
  ] as KeryxPlugin[],
};
