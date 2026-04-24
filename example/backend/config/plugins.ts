import { observabilityPlugin } from "@keryxjs/observability";
import { resqueAdminPlugin } from "@keryxjs/resque-admin";
import type { KeryxPlugin } from "keryx";

export default {
  plugins: [observabilityPlugin, resqueAdminPlugin] as KeryxPlugin[],
};
