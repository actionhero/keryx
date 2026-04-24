import { resqueAdminPlugin } from "@keryxjs/resque-admin";
import { tracingPlugin } from "@keryxjs/tracing";
import type { KeryxPlugin } from "keryx";

export default {
  plugins: [tracingPlugin, resqueAdminPlugin] as KeryxPlugin[],
};
