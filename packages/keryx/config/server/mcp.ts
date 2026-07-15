import pkg from "../../package.json";
import { loadFromEnvIfSet } from "../../util/config";

export const configServerMcp = {
  enabled: await loadFromEnvIfSet("MCP_SERVER_ENABLED", false),
  route: await loadFromEnvIfSet("MCP_SERVER_ROUTE", "/mcp"),
  allowedOrigins: await loadFromEnvIfSet(
    "MCP_ALLOWED_ORIGINS",
    [
      "https://claude.ai", // Anthropic Claude web connector
      "https://claude.com", // Anthropic Claude web connector
      "https://chatgpt.com", // OpenAI ChatGPT connectors
      "https://vscode.dev", // VS Code for the Web
      "https://github.dev", // github.dev web editor
    ].join(","),
  ),
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
  oauthTrustProxy: await loadFromEnvIfSet("MCP_OAUTH_TRUST_PROXY", false),
  markdownDepthLimit: await loadFromEnvIfSet("MCP_MARKDOWN_DEPTH_LIMIT", 5),
};
