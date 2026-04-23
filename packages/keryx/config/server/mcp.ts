import pkg from "../../package.json";
import { loadFromEnvIfSet } from "../../util/config";

export const configServerMcp = {
  enabled: await loadFromEnvIfSet("MCP_SERVER_ENABLED", false),
  route: await loadFromEnvIfSet("MCP_SERVER_ROUTE", "/mcp"),
  instructions: await loadFromEnvIfSet(
    "MCP_SERVER_INSTRUCTIONS",
    pkg.description as string,
  ),
  oauthClientTtl: await loadFromEnvIfSet(
    "MCP_OAUTH_CLIENT_TTL",
    60 * 60 * 24 * 30,
  ), // 30 days, in seconds
  oauthCodeTtl: await loadFromEnvIfSet("MCP_OAUTH_CODE_TTL", 300), // 5 minutes, in seconds
  oauthRefreshTtl: await loadFromEnvIfSet(
    "MCP_OAUTH_REFRESH_TTL",
    60 * 60 * 24 * 30,
  ), // 30 days, in seconds
  markdownDepthLimit: await loadFromEnvIfSet("MCP_MARKDOWN_DEPTH_LIMIT", 5),
};
