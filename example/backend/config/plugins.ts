import { csrfPlugin } from "@keryxjs/csrf";
import { resqueAdminPlugin } from "@keryxjs/resque-admin";
import { tracingPlugin } from "@keryxjs/tracing";
import type { KeryxPlugin } from "keryx";
import { SessionMiddleware } from "../middleware/session";

export default {
  plugins: [
    tracingPlugin,
    resqueAdminPlugin,
    csrfPlugin({ tokenActionMiddleware: [SessionMiddleware] }),
  ] as KeryxPlugin[],
};
