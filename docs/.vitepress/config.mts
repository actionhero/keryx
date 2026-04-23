import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitepress";
import llmstxt, {
  copyOrDownloadAsMarkdownButtons,
} from "vitepress-plugin-llms";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../packages/keryx/package.json"),
    "utf-8",
  ),
);
const version: string = pkg.version;

export const LLM_LANDING_PAGE = `# Keryx

> The fullstack TypeScript framework for MCP and APIs, built on Bun.

This is the Keryx documentation site. Two LLM-friendly documentation formats are available:

- [llms.txt](/llms.txt) — Table of contents with links to all documentation pages
- [llms-full.txt](/llms-full.txt) — Complete documentation bundle (all pages in one file)

## Per-Page Markdown

Each documentation page is available in Markdown format by appending \`.md\` to the URL.
For example: \`/guide/actions.md\`, \`/reference/config.md\`

## Guide

- Getting Started: /guide/index.md
- About Keryx: /guide/about.md
- Actions: /guide/actions.md
- Streaming: /guide/streaming.md
- Initializers: /guide/initializers.md
- Channels: /guide/channels.md
- Tasks: /guide/tasks.md
- Middleware: /guide/middleware.md
- MCP Server: /guide/mcp.md
- Configuration: /guide/config.md
- Plugins: /guide/plugins.md
- CLI: /guide/cli.md
- Authentication: /guide/authentication.md
- Typed Clients: /guide/typed-clients.md
- Building for AI Agents: /guide/agents.md
- Caching: /guide/caching.md
- Security: /guide/security.md
- Advanced Patterns: /guide/advanced-patterns.md
- Testing: /guide/testing.md
- Deployment: /guide/deployment.md
- Coming from ActionHero: /guide/from-actionhero.md
- Framework Comparisons: /guide/comparisons.md

## Reference

- Action class: /reference/actions.md
- Initializer class: /reference/initializers.md
- API, Connection, Channel, Server, TypedError, Logger: /reference/classes.md
- Servers (HTTP, WebSocket, CLI, MCP): /reference/servers.md
- Zod Helpers & Utilities: /reference/utilities.md
- Configuration Reference: /reference/config.md

## Plugins

- Plugins Overview: /plugins/index.md
- Resque Admin: /plugins/resque-admin.md
`;

export function toMarkdownUrl(url: string): string {
  const cleanUrl = url.split("?")[0].split("#")[0];
  if (cleanUrl.endsWith(".md")) return cleanUrl;
  if (cleanUrl.endsWith("/index.html"))
    return cleanUrl.replace(/\/index\.html$/, "/index.md");
  if (cleanUrl.endsWith(".html")) return cleanUrl.replace(/\.html$/, ".md");
  if (cleanUrl.endsWith("/")) return cleanUrl + "index.md";
  return cleanUrl + ".md";
}

function addLlmMiddleware(server: {
  middlewares: {
    use: (fn: (req: any, res: any, next: () => void) => void) => void;
  };
}) {
  server.middlewares.use((req, res, next) => {
    const accept = req.headers["accept"] ?? "";
    if (!accept.includes("text/markdown")) return next();

    const url = (req.url ?? "/").split("?")[0];

    if (url === "/" || url === "/index.html") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.end(LLM_LANDING_PAGE);
      return;
    }

    res.writeHead(302, { Location: toMarkdownUrl(url) });
    res.end();
  });
}

export default defineConfig({
  appearance: "dark",
  title: "Keryx",
  description:
    "The fullstack TypeScript framework for MCP and APIs — transport-agnostic actions for HTTP, WebSocket, CLI, background tasks, and MCP, built on Bun.",
  transformHead({ pageData }) {
    const mdUrl = "/" + pageData.relativePath;
    return [["link", { rel: "alternate", type: "text/markdown", href: mdUrl }]];
  },

  head: [
    ["link", { rel: "icon", href: "/images/horn.svg" }],
    [
      "link",
      {
        rel: "alternate",
        type: "text/plain",
        href: "/llms.txt",
        title: "LLM documentation index",
      },
    ],
    [
      "link",
      {
        rel: "alternate",
        type: "text/plain",
        href: "/llms-full.txt",
        title: "Full LLM documentation",
      },
    ],
    [
      "script",
      {
        async: "",
        src: "https://www.googletagmanager.com/gtag/js?id=G-G4F5PLL4QD",
      },
    ],
    [
      "script",
      {},
      "window.dataLayer = window.dataLayer || [];\nfunction gtag(){dataLayer.push(arguments);}\ngtag('js', new Date());\ngtag('config', 'G-G4F5PLL4QD');",
    ],
  ],

  markdown: {
    config: (md) => {
      md.use(copyOrDownloadAsMarkdownButtons);
    },
  },

  themeConfig: {
    logo: "/images/horn.svg",
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Plugins", link: "/plugins/" },
      { text: "Reference", link: "/reference/actions" },
      { text: "Changelog", link: "/changelog" },
      {
        text: `v${version}`,
        items: [
          { text: "Changelog", link: "/changelog" },
          { text: "npm", link: "https://www.npmjs.com/package/keryx" },
        ],
      },
      {
        text: "GitHub",
        link: "https://github.com/actionhero/keryx",
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "Getting Started", link: "/guide/" },
            { text: "About Keryx", link: "/guide/about" },
          ],
        },
        {
          text: "Core Concepts",
          items: [
            { text: "Actions", link: "/guide/actions" },
            { text: "Streaming", link: "/guide/streaming" },
            { text: "Initializers", link: "/guide/initializers" },
            { text: "Channels", link: "/guide/channels" },
            { text: "Tasks", link: "/guide/tasks" },
            { text: "Middleware", link: "/guide/middleware" },
            { text: "MCP", link: "/guide/mcp" },
            { text: "Configuration", link: "/guide/config" },
            { text: "Plugins", link: "/guide/plugins" },
          ],
        },
        {
          text: "Usage",
          items: [
            { text: "CLI", link: "/guide/cli" },
            { text: "Authentication", link: "/guide/authentication" },
            { text: "Typed Clients", link: "/guide/typed-clients" },
            {
              text: "Building for AI Agents",
              link: "/guide/agents",
            },
            { text: "Caching", link: "/guide/caching" },
            { text: "Security", link: "/guide/security" },
            { text: "Advanced Patterns", link: "/guide/advanced-patterns" },
            { text: "Testing", link: "/guide/testing" },
            { text: "Deployment", link: "/guide/deployment" },
          ],
        },
        {
          text: "Migration",
          items: [
            {
              text: "Coming from ActionHero",
              link: "/guide/from-actionhero",
            },
          ],
        },
        {
          text: "Comparisons",
          items: [
            {
              text: "Framework Comparisons",
              link: "/guide/comparisons",
            },
          ],
        },
        {
          text: "Contributing",
          items: [{ text: "Style Guide", link: "/guide/style-guide" }],
        },
      ],
      "/plugins/": [
        {
          text: "First-Party Plugins",
          items: [
            { text: "Overview", link: "/plugins/" },
            { text: "Observability", link: "/plugins/observability" },
            { text: "Resque Admin", link: "/plugins/resque-admin" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Classes",
          items: [
            { text: "Action", link: "/reference/actions" },
            { text: "Initializer", link: "/reference/initializers" },
            {
              text: "API, Connection, Channel & more",
              link: "/reference/classes",
            },
          ],
        },
        {
          text: "Transports",
          items: [
            {
              text: "Servers (HTTP, WebSocket, CLI, MCP)",
              link: "/reference/servers",
            },
          ],
        },
        {
          text: "Utilities",
          items: [
            {
              text: "Zod Helpers & Mixins",
              link: "/reference/utilities",
            },
          ],
        },
        {
          text: "Configuration",
          items: [{ text: "Config Reference", link: "/reference/config" }],
        },
      ],
    },
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/actionhero/keryx",
      },
    ],
    search: { provider: "local" },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2024-present Evan Tahler",
    },
  },

  sitemap: { hostname: "https://keryxjs.com" },

  vite: {
    plugins: [
      llmstxt({
        generateLLMFriendlyDocsForEachPage: true,
        domain: "https://keryxjs.com",
        customLLMsTxtTemplate: `# {title}

> {description}

{details}

For the complete documentation in a single file, see [llms-full.txt](/llms-full.txt).

## Table of Contents

{toc}`,
      }),
      {
        name: "llm-markdown-routing",
        configureServer: addLlmMiddleware,
        configurePreviewServer: addLlmMiddleware,
      },
    ],
  },
});
