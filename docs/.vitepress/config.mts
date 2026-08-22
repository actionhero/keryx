import { readFileSync, writeFileSync } from "fs";
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
/** Shared "when to use" + resources block, used in both the landing page and
 * the generated llms.txt so agents get consistent guidance either way. */
export const LLM_WHEN_TO_USE = `## When to use Keryx

Reach for Keryx when you are building a TypeScript/Bun backend that must be
callable by both people and AI agents from one code base. It is the right fit
when you want to:

- Expose your API to AI agents as MCP tools **without** writing a separate MCP
  server — add \`mcp = { tool: true }\` to an action and it becomes a tool.
- Serve the same logic over HTTP, WebSocket, a CLI, and background jobs at once,
  with one set of Zod-validated inputs, middleware, and typed errors.
- Give agents OAuth 2.1 + PKCE auth that works exactly like your browser clients'.
- Ship an auto-generated OpenAPI spec and real-time PubSub channels.

Keryx is **not** a good fit for tiny static sites, serverless-only edge
functions with no long-lived process, or projects that cannot run Bun,
PostgreSQL, and Redis.

### How an agent should call Keryx

1. Read the OpenAPI spec at [/openapi.json](/openapi.json) to discover endpoints.
2. Discover auth via [/.well-known/oauth-protected-resource](/.well-known/oauth-protected-resource)
   and [/.well-known/oauth-authorization-server](/.well-known/oauth-authorization-server).
3. Connect over MCP (Streamable HTTP) using [/.well-known/mcp](/.well-known/mcp);
   the demo server is at \`https://api.demo.keryxjs.com/mcp\`.
4. See the [Developer Portal](/developers) for a runnable sandbox and quickstart.`;

export const LLM_LANDING_PAGE = `# Keryx

> The fullstack TypeScript framework for MCP and APIs, built on Bun.

This is the Keryx documentation site. Two LLM-friendly documentation formats are available:

- [llms.txt](/llms.txt) — Table of contents with links to all documentation pages
- [llms-full.txt](/llms-full.txt) — Complete documentation bundle (all pages in one file)

${LLM_WHEN_TO_USE}

## Developer Resources

- [Developer Portal](/developers) — API reference, sandbox, auth, MCP, CLI
- [OpenAPI spec](/openapi.json) — full API surface for the live demo
- [About](/about) · [Contact](/contact) · [Privacy](/privacy)

## Per-Page Markdown

Each documentation page is available in Markdown format by appending \`.md\` to the URL.
For example: \`/guide/actions.md\`, \`/reference/config.md\`

${renderLlmSection("Guide", GUIDE_SIDEBAR)}

${renderLlmSection("Reference", REFERENCE_SIDEBAR)}

${renderLlmSection("Plugins", PLUGINS_SIDEBAR)}

## Project

- Changelog: /changelog.md
`;

const SITE_HOSTNAME = "https://keryxjs.com";

/**
 * JSON-LD identity graph for the homepage (and every page). Lets AI agents and
 * search engines resolve "Keryx" to this domain, its author, and its source.
 * Includes a `SoftwareApplication` (the product) and an `Organization` with a
 * `contactPoint` and `address` so business-legitimacy checks have something to
 * read.
 */
export const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_HOSTNAME}/#software`,
      name: "Keryx",
      alternateName: "KeryxJS",
      description:
        "The fullstack TypeScript framework for MCP and APIs — write one action and serve HTTP, WebSocket, CLI, background tasks, and MCP tools, built on Bun.",
      url: SITE_HOSTNAME,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Cross-platform (Bun)",
      softwareVersion: version,
      license: "https://opensource.org/licenses/MIT",
      downloadUrl: "https://www.npmjs.com/package/keryx",
      softwareHelp: `${SITE_HOSTNAME}/guide/`,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: {
        "@type": "Person",
        name: "Evan Tahler",
        url: "https://evantahler.com",
      },
      sameAs: [
        "https://github.com/actionhero/keryx",
        "https://www.npmjs.com/package/keryx",
      ],
    },
    {
      "@type": "Organization",
      "@id": `${SITE_HOSTNAME}/#organization`,
      name: "Keryx",
      alternateName: "KeryxJS",
      url: SITE_HOSTNAME,
      logo: `${SITE_HOSTNAME}/images/hearald.svg`,
      description:
        "Open-source fullstack TypeScript framework for MCP servers and APIs, built on Bun.",
      founder: { "@type": "Person", name: "Evan Tahler" },
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "technical support",
        email: "evan@evantahler.com",
        url: `${SITE_HOSTNAME}/contact`,
        availableLanguage: ["English"],
      },
      address: {
        "@type": "PostalAddress",
        addressCountry: "US",
      },
      sameAs: [
        "https://github.com/actionhero/keryx",
        "https://www.npmjs.com/package/keryx",
        "https://slack.actionherojs.com",
      ],
    },
  ],
};

/** Absolute canonical URL for a page, matching VitePress's default output. */
export function canonicalUrl(relativePath: string): string {
  const path = relativePath
    .replace(/\.md$/, ".html")
    .replace(/(^|\/)index\.html$/, "$1");
  return `${SITE_HOSTNAME}/${path}`;
}

/**
 * Recovery links shown on the 404 page. Kept in one place so the client
 * `NotFound.vue` component and the statically-injected 404 body stay in sync.
 */
export const NOT_FOUND_LINKS: { text: string; href: string; note: string }[] = [
  { text: "Home", href: "/", note: "Keryx overview and quick start" },
  { text: "Guide", href: "/guide/", note: "Concepts, transports, and how-tos" },
  {
    text: "API Reference",
    href: "/reference/actions",
    note: "Actions, initializers, servers, config",
  },
  {
    text: "Developer Portal",
    href: "/developers",
    note: "OpenAPI spec, auth, sandbox, MCP, CLI",
  },
  {
    text: "llms.txt",
    href: "/llms.txt",
    note: "Machine-readable index of every page",
  },
  {
    text: "OpenAPI spec",
    href: "/openapi.json",
    note: "Full API surface for the live demo",
  },
  { text: "Sitemap", href: "/sitemap.xml", note: "Every URL on this site" },
];

/**
 * Static HTML injected into the built `404.html` so agents and crawlers that
 * don't execute JavaScript still get a helpful, recoverable body (VitePress
 * otherwise renders the not-found page only client-side). Written as a small
 * Markdown-style document with links to the sitemap, llms.txt, and docs index.
 */
export const NOT_FOUND_STATIC_BODY = `<div class="vp-doc" style="max-width:640px;margin:0 auto;padding:64px 24px">
<h1>404 — Page not found</h1>
<p>That page doesn't exist. This site is the documentation for <strong>Keryx</strong>, the fullstack TypeScript framework for MCP and APIs. Here's where to look next — this index is also available as machine-readable Markdown at <a href="/llms.txt">/llms.txt</a>.</p>
<ul>
${NOT_FOUND_LINKS.map(
  (l) => `<li><a href="${l.href}">${l.text}</a> — ${l.note}</li>`,
).join("\n")}
</ul>
</div>`;

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
  lang: "en-US",
  // Reads each page's last git commit date; themeConfig.lastUpdated formats it.
  lastUpdated: true,
  title: "Keryx",
  description:
    "The fullstack TypeScript framework for MCP and APIs — transport-agnostic actions for HTTP, WebSocket, CLI, background tasks, and MCP, built on Bun.",
  // Per-page <head> additions: the Markdown alternate link, a canonical URL,
  // and og:url. Agents use these for entity resolution and attribution.
  transformHead({ pageData }) {
    const mdUrl = "/" + pageData.relativePath;
    const canonical = canonicalUrl(pageData.relativePath);
    return [
      ["link", { rel: "alternate", type: "text/markdown", href: mdUrl }],
      ["link", { rel: "canonical", href: canonical }],
      ["meta", { property: "og:url", content: canonical }],
    ];
  },

  head: [
    ["link", { rel: "icon", href: "/images/horn.svg" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Keryx" }],
    [
      "meta",
      { property: "og:image", content: `${SITE_HOSTNAME}/images/hearald.svg` },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    [
      "meta",
      { name: "twitter:image", content: `${SITE_HOSTNAME}/images/hearald.svg` },
    ],
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify(STRUCTURED_DATA),
    ],
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
      { text: "Developers", link: "/developers" },
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

  sitemap: { hostname: "https://keryxjs.com" },

  // The `.well-known` discovery documents are static files in `public/`, not
  // VitePress pages, so the dead-link checker can't resolve them. They are
  // verified by the docs test suite instead.
  ignoreDeadLinks: [/^\/\.well-known\//],

  // VitePress renders the not-found page only on the client, leaving a bare
  // shell in the static 404.html. Inject a helpful, link-rich body so agents
  // and crawlers that don't run JavaScript can still recover. The client-side
  // NotFound.vue component replaces this once hydrated.
  buildEnd(siteConfig) {
    const notFoundPath = resolve(siteConfig.outDir, "404.html");
    try {
      const html = readFileSync(notFoundPath, "utf-8");
      const injected = html.replace(
        '<div id="app"></div>',
        `<div id="app">${NOT_FOUND_STATIC_BODY}</div>`,
      );
      if (injected !== html) writeFileSync(notFoundPath, injected);
    } catch {
      // If the 404.html shape changes upstream, don't fail the build.
    }
  },

  vite: {
    plugins: [
      llmstxt({
        generateLLMFriendlyDocsForEachPage: true,
        domain: "https://keryxjs.com",
        customLLMsTxtTemplate: `# {title}

> {description}

{details}

For the complete documentation in a single file, see [llms-full.txt](/llms-full.txt).

${LLM_WHEN_TO_USE}

## Developer Resources

- [Developer Portal](/developers) — API reference, sandbox, auth, MCP, CLI
- [OpenAPI spec](/openapi.json) — full API surface for the live demo
- [About](/about) · [Contact](/contact) · [Privacy](/privacy)

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
