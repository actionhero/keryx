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

/** keryxjs.com redirects to www, so absolute URLs use the final host. */
const SITE_URL = "https://www.keryxjs.com";
const OG_IMAGE = `${SITE_URL}/images/og-image.png`;

type SidebarItem = { text: string; link: string };
type SidebarGroup = { text: string; items: SidebarItem[] };

/**
 * The guide is grouped by what the reader is trying to do, not by how the
 * framework is built. Order within each group is the order you'd meet the
 * ideas building a real app.
 */
export const GUIDE_SIDEBAR: SidebarGroup[] = [
  {
    // Orientation: what this is, whether it's for you, how it compares.
    text: "Introduction",
    items: [
      { text: "Getting Started", link: "/guide/" },
      { text: "About Keryx", link: "/guide/about" },
      { text: "Coming from ActionHero", link: "/guide/from-actionhero" },
      { text: "Framework Comparisons", link: "/guide/comparisons" },
    ],
  },
  {
    // The primitives. Everything else composes these.
    text: "Core Concepts",
    items: [
      { text: "Actions", link: "/guide/actions" },
      { text: "Initializers", link: "/guide/initializers" },
      { text: "Middleware", link: "/guide/middleware" },
      { text: "Channels", link: "/guide/channels" },
      { text: "Background Tasks", link: "/guide/tasks" },
      { text: "Configuration", link: "/guide/config" },
    ],
  },
  {
    // How an action reaches the outside world.
    text: "Transports & Clients",
    items: [
      { text: "Streaming", link: "/guide/streaming" },
      { text: "CLI", link: "/guide/cli" },
      { text: "MCP Server", link: "/guide/mcp" },
      { text: "MCP Apps", link: "/guide/mcp-apps" },
      { text: "Building for AI Agents", link: "/guide/agents" },
      { text: "Typed Clients", link: "/guide/typed-clients" },
    ],
  },
  {
    // Things you reach for once the shape of the app exists.
    text: "Building Your App",
    items: [
      { text: "Authentication", link: "/guide/authentication" },
      { text: "Caching", link: "/guide/caching" },
      { text: "Advanced Patterns", link: "/guide/advanced-patterns" },
      { text: "Plugins", link: "/guide/plugins" },
    ],
  },
  {
    // Everything between "it works locally" and "it's serving traffic".
    text: "Going to Production",
    items: [
      { text: "Testing", link: "/guide/testing" },
      { text: "Security", link: "/guide/security" },
      { text: "Observability", link: "/guide/observability" },
      { text: "Deployment", link: "/guide/deployment" },
    ],
  },
  {
    // Different audience: people editing these docs, not people using Keryx.
    text: "Contributing",
    items: [{ text: "Docs Style Guide", link: "/guide/style-guide" }],
  },
];

/** Six pages don't need four headings. Flat, alphabetical by concept. */
export const REFERENCE_SIDEBAR: SidebarGroup[] = [
  {
    text: "Reference",
    items: [
      { text: "Action", link: "/reference/actions" },
      { text: "Initializer", link: "/reference/initializers" },
      { text: "Core Classes", link: "/reference/classes" },
      { text: "Servers", link: "/reference/servers" },
      { text: "Utilities", link: "/reference/utilities" },
      { text: "Configuration", link: "/reference/config" },
    ],
  },
];

export const PLUGINS_SIDEBAR: SidebarGroup[] = [
  {
    text: "First-Party Plugins",
    items: [
      { text: "Overview", link: "/plugins/" },
      { text: "Tracing", link: "/plugins/tracing" },
      { text: "Sentry", link: "/plugins/sentry" },
      { text: "Resque Admin", link: "/plugins/resque-admin" },
      { text: "CSRF", link: "/plugins/csrf" },
      { text: "Admin", link: "/plugins/admin" },
    ],
  },
];

/** Render a sidebar group as markdown links for the LLM landing page. */
function renderLlmSection(heading: string, groups: SidebarGroup[]): string {
  const lines = [`## ${heading}`, ""];
  for (const group of groups) {
    for (const item of group.items) {
      const path = item.link.endsWith("/")
        ? `${item.link}index.md`
        : `${item.link}.md`;
      lines.push(`- ${item.text}: ${path}`);
    }
  }
  return lines.join("\n");
}

// Derived from the sidebars above rather than hand-maintained — the previous
// hand-written list had silently drifted, omitting the changelog and the style
// guide. Adding a page to a sidebar now adds it here too.
export const LLM_LANDING_PAGE = `# Keryx

> The fullstack TypeScript framework for MCP and APIs, built on Bun.

This is the Keryx documentation site. Two LLM-friendly documentation formats are available:

- [llms.txt](/llms.txt) — Table of contents with links to all documentation pages
- [llms-full.txt](/llms-full.txt) — Complete documentation bundle (all pages in one file)

## Per-Page Markdown

Each documentation page is available in Markdown format by appending \`.md\` to the URL.
For example: \`/guide/actions.md\`, \`/reference/config.md\`

${renderLlmSection("Guide", GUIDE_SIDEBAR)}

${renderLlmSection("Reference", REFERENCE_SIDEBAR)}

${renderLlmSection("Plugins", PLUGINS_SIDEBAR)}

## Project

- Changelog: /changelog.md
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
  // Reads each page's last git commit date; themeConfig.lastUpdated formats it.
  lastUpdated: true,
  title: "Keryx",
  description:
    "The fullstack TypeScript framework for MCP and APIs — transport-agnostic actions for HTTP, WebSocket, CLI, background tasks, and MCP, built on Bun.",
  transformHead({ pageData, siteData }) {
    const mdUrl = "/" + pageData.relativePath;
    // Social unfurls (Slack, X, LinkedIn, Discord) need absolute URLs and a
    // raster image — SVGs are ignored, which leaves an empty placeholder card.
    const path = pageData.relativePath
      .replace(/(^|\/)index\.md$/, "$1")
      .replace(/\.md$/, ".html");
    const url = `${SITE_URL}/${path}`;
    const title =
      pageData.frontmatter.layout === "home" || !pageData.title
        ? siteData.title
        : `${pageData.title} | ${siteData.title}`;
    const description = pageData.description || siteData.description;
    return [
      ["link", { rel: "alternate", type: "text/markdown", href: mdUrl }],
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:site_name", content: siteData.title }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:image", content: OG_IMAGE }],
      ["meta", { property: "og:image:width", content: "1200" }],
      ["meta", { property: "og:image:height", content: "630" }],
      ["meta", { property: "og:image:alt", content: "Keryx herald" }],
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
      ["meta", { name: "twitter:image", content: OG_IMAGE }],
    ];
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
      "/guide/": GUIDE_SIDEBAR,
      "/plugins/": PLUGINS_SIDEBAR,
      "/reference/": REFERENCE_SIDEBAR,
    },
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/actionhero/keryx",
      },
    ],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/actionhero/keryx/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    lastUpdated: {
      text: "Last updated",
      formatOptions: { dateStyle: "medium" },
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2024-present Evan Tahler",
    },
  },

  sitemap: { hostname: SITE_URL },

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
