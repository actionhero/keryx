import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, relative, resolve } from "path";
import { LLM_LANDING_PAGE, toMarkdownUrl } from "../.vitepress/config.mts";

const docsDir = resolve(import.meta.dir, "..");
const publicDir = resolve(docsDir, "public");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      files.push(...getMarkdownFiles(resolve(dir, entry.name)));
    } else if (entry.name.endsWith(".md")) {
      files.push(resolve(dir, entry.name));
    }
  }
  return files;
}

/** Extract YAML frontmatter from a markdown file (simple parser, no deps). */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep > 0) {
      const key = line.slice(0, sep).trim();
      const val = line.slice(sep + 1).trim();
      fm[key] = val;
    }
  }
  return fm;
}

/** Recursively extract all `link` values from sidebar config. */
function extractSidebarLinks(obj: unknown): string[] {
  const links: string[] = [];
  if (Array.isArray(obj)) {
    for (const item of obj) links.push(...extractSidebarLinks(item));
  } else if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.link === "string") links.push(rec.link);
    if (rec.items) links.push(...extractSidebarLinks(rec.items));
  }
  return links;
}

/** Convert a sidebar link like `/guide/actions` to its markdown file path. */
function linkToFile(link: string): string {
  // `/guide/` → `docs/guide/index.md`, `/guide/actions` → `docs/guide/actions.md`
  if (link.endsWith("/")) return resolve(docsDir, link.slice(1) + "index.md");
  return resolve(docsDir, link.slice(1) + ".md");
}

/** Convert a markdown file path to the sidebar link it should have. */
function fileToLink(file: string): string {
  const rel = relative(docsDir, file).replace(/\.md$/, "");
  if (rel.endsWith("/index") || rel === "index") {
    return "/" + rel.replace(/index$/, "");
  }
  return "/" + rel;
}

// ---------------------------------------------------------------------------
// Load sidebar config by importing the VitePress config
// ---------------------------------------------------------------------------

const config = await import("../.vitepress/config.mts");
const sidebar = config.default.themeConfig?.sidebar as Record<
  string,
  unknown[]
>;
const allSidebarLinks = Object.values(sidebar).flatMap(extractSidebarLinks);

// All guide + reference markdown files (the ones that should be navigable)
const contentFiles = [
  ...getMarkdownFiles(resolve(docsDir, "guide")),
  ...getMarkdownFiles(resolve(docsDir, "reference")),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sidebar", () => {
  test("every sidebar link resolves to a file", () => {
    const missing: string[] = [];
    for (const link of allSidebarLinks) {
      const file = linkToFile(link);
      if (!existsSync(file)) missing.push(`${link} → ${file}`);
    }
    expect(missing).toEqual([]);
  });

  test("every guide/reference page is in the sidebar", () => {
    const orphans: string[] = [];
    for (const file of contentFiles) {
      const link = fileToLink(file);
      if (!allSidebarLinks.includes(link)) {
        orphans.push(`${relative(docsDir, file)} (expected ${link})`);
      }
    }
    expect(orphans).toEqual([]);
  });
});

describe("frontmatter", () => {
  const allMarkdown = getMarkdownFiles(docsDir).filter(
    (f) => !f.includes("__tests__") && !f.includes("node_modules"),
  );

  test("every page has a description", () => {
    const missing: string[] = [];
    for (const file of allMarkdown) {
      const content = readFileSync(file, "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm || !fm.description) {
        missing.push(relative(docsDir, file));
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("images", () => {
  test("all image references resolve to files in public/", () => {
    const allMarkdown = getMarkdownFiles(docsDir).filter(
      (f) => !f.includes("node_modules"),
    );
    const broken: string[] = [];

    for (const file of allMarkdown) {
      const content = readFileSync(file, "utf-8");
      // Match markdown images ![alt](/images/...) and HTML <img src="/images/...">
      const imgRefs = [
        ...content.matchAll(/!\[.*?\]\((\/images\/[^)]+)\)/g),
        ...content.matchAll(/src="(\/images\/[^"]+)"/g),
      ];
      for (const match of imgRefs) {
        const imgPath = resolve(publicDir, match[1].slice(1)); // strip leading /
        if (!existsSync(imgPath)) {
          broken.push(`${relative(docsDir, file)}: ${match[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("internal links", () => {
  test("all internal markdown links resolve to files", () => {
    const allMarkdown = getMarkdownFiles(docsDir).filter(
      (f) => !f.includes("node_modules"),
    );
    const broken: string[] = [];

    for (const file of allMarkdown) {
      const content = readFileSync(file, "utf-8");
      // Match [text](/guide/...) or [text](/reference/...) style links
      const linkRefs = content.matchAll(
        /\[.*?\]\(\/(guide|reference)(\/[^)#]*)?\)/g,
      );
      for (const match of linkRefs) {
        const link = "/" + match[1] + (match[2] ?? "");
        const target = link.endsWith("/")
          ? resolve(docsDir, link.slice(1) + "index.md")
          : resolve(docsDir, link.slice(1) + ".md");
        if (!existsSync(target)) {
          broken.push(`${relative(docsDir, file)}: ${link}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("internal link anchors", () => {
  /** Convert a markdown heading to its VitePress slug (GitHub-flavored). */
  function headingToSlug(heading: string): string {
    return heading
      .toLowerCase()
      .replace(/[^\w\s-]/g, "") // strip non-word chars except spaces/hyphens
      .replace(/\s+/g, "-") // spaces → hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
  }

  /** Extract all heading slugs from a markdown file. */
  function extractHeadingSlugs(content: string): Set<string> {
    const slugs = new Set<string>();
    for (const match of content.matchAll(/^#{1,6}\s+(.+)$/gm)) {
      // Strip inline code backticks and markdown links for slug generation
      const text = match[1]
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      slugs.add(headingToSlug(text));
    }
    return slugs;
  }

  test("all internal link anchors resolve to headings", () => {
    const allMarkdown = getMarkdownFiles(docsDir).filter(
      (f) => !f.includes("node_modules"),
    );
    const broken: string[] = [];

    for (const file of allMarkdown) {
      const content = readFileSync(file, "utf-8");
      // Match [text](/guide/foo#anchor) or [text](/reference/foo#anchor)
      const linkRefs = content.matchAll(
        /\[.*?\]\(\/(guide|reference)(\/[^)#]*)?#([^)]+)\)/g,
      );
      for (const match of linkRefs) {
        const link = "/" + match[1] + (match[2] ?? "");
        const anchor = match[3];
        const targetFile = link.endsWith("/")
          ? resolve(docsDir, link.slice(1) + "index.md")
          : resolve(docsDir, link.slice(1) + ".md");

        if (!existsSync(targetFile)) {
          broken.push(
            `${relative(docsDir, file)}: ${link}#${anchor} (file missing)`,
          );
          continue;
        }

        const targetContent = readFileSync(targetFile, "utf-8");
        const slugs = extractHeadingSlugs(targetContent);
        if (!slugs.has(anchor)) {
          broken.push(
            `${relative(docsDir, file)}: ${link}#${anchor} (no such heading)`,
          );
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("source sync", () => {
  test("CLI docs list all generator types from source", () => {
    const registrySrc = readFileSync(
      resolve(
        docsDir,
        "..",
        "packages",
        "keryx",
        "util",
        "componentRegistry.ts",
      ),
      "utf-8",
    );
    // Extract type names from the BUILT_IN_DEFS array
    const defsMatch = registrySrc.match(
      /BUILT_IN_DEFS\s*:\s*ComponentDef\[\]\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(defsMatch).not.toBeNull();

    const sourceTypes = [...defsMatch![1].matchAll(/type:\s*"([\w-]+)"/g)].map(
      (m) => m[1],
    );
    expect(sourceTypes.length).toBeGreaterThan(0);

    // Check that the CLI docs page mentions every type
    const cliDocs = readFileSync(resolve(docsDir, "guide", "cli.md"), "utf-8");
    const missing: string[] = [];
    for (const type of sourceTypes) {
      // Each type should appear in the supported types table as `type`
      if (!cliDocs.includes(`\`${type}\``)) {
        missing.push(type);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("llms.txt", () => {
  const distDir = resolve(docsDir, ".vitepress", "dist");
  const llmsTxt = resolve(distDir, "llms.txt");
  const llmsFullTxt = resolve(distDir, "llms-full.txt");

  test("llms.txt is generated", () => {
    expect(existsSync(llmsTxt)).toBe(true);
    expect(existsSync(llmsFullTxt)).toBe(true);
  });

  test("llms.txt includes every guide and reference page", () => {
    const content = readFileSync(llmsTxt, "utf-8");
    const missing: string[] = [];
    for (const file of contentFiles) {
      // llms.txt uses paths like /guide/actions.md, /guide.md (for index)
      let rel = relative(docsDir, file);
      if (rel === "guide/index.md") rel = "guide.md";
      if (!content.includes(rel)) {
        missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });

  test("llms-full.txt includes content from every guide and reference page", () => {
    const content = readFileSync(llmsFullTxt, "utf-8");
    const missing: string[] = [];
    for (const file of contentFiles) {
      // Each page appears as a section header with its url
      let rel = relative(docsDir, file);
      if (rel === "guide/index.md") rel = "guide.md";
      if (!content.includes(rel)) {
        missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LLM markdown routing
// ---------------------------------------------------------------------------

describe("toMarkdownUrl", () => {
  test("clean URL → .md", () => {
    expect(toMarkdownUrl("/guide/actions")).toBe("/guide/actions.md");
  });

  test(".html → .md", () => {
    expect(toMarkdownUrl("/guide/actions.html")).toBe("/guide/actions.md");
  });

  test("trailing slash → index.md", () => {
    expect(toMarkdownUrl("/guide/")).toBe("/guide/index.md");
  });

  test("index.html → index.md", () => {
    expect(toMarkdownUrl("/guide/index.html")).toBe("/guide/index.md");
  });

  test("already .md → unchanged", () => {
    expect(toMarkdownUrl("/guide/actions.md")).toBe("/guide/actions.md");
  });

  test("strips query string before converting", () => {
    expect(toMarkdownUrl("/guide/actions?foo=bar")).toBe("/guide/actions.md");
  });

  test("strips hash before converting", () => {
    expect(toMarkdownUrl("/guide/actions#section")).toBe("/guide/actions.md");
  });
});

describe("LLM markdown middleware (dev server)", () => {
  const PORT = 5199;
  const baseUrl = `http://localhost:${PORT}`;
  let serverProcess: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    serverProcess = Bun.spawn(
      ["bunx", "vitepress", "dev", "--port", String(PORT)],
      {
        cwd: docsDir,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    // Wait for the dev server to be ready
    const maxWait = 30_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const res = await fetch(baseUrl);
        if (res.ok) break;
      } catch {
        // Server not ready yet
      }
      await Bun.sleep(500);
    }
  }, 60_000);

  afterAll(() => {
    serverProcess?.kill();
  });

  test("root with Accept: text/markdown returns LLM landing page", async () => {
    const res = await fetch(baseUrl, {
      headers: { Accept: "text/markdown" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toBe(LLM_LANDING_PAGE);
  });

  test("root without Accept: text/markdown returns HTML", async () => {
    const res = await fetch(baseUrl, {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("guide page with Accept: text/markdown redirects to .md", async () => {
    const res = await fetch(`${baseUrl}/guide/actions`, {
      headers: { Accept: "text/markdown" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/guide/actions.md");
  });

  test("guide page with .html and Accept: text/markdown redirects to .md", async () => {
    const res = await fetch(`${baseUrl}/guide/actions.html`, {
      headers: { Accept: "text/markdown" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/guide/actions.md");
  });

  test("trailing slash with Accept: text/markdown redirects to index.md", async () => {
    const res = await fetch(`${baseUrl}/guide/`, {
      headers: { Accept: "text/markdown" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/guide/index.md");
  });

  test("guide page without Accept: text/markdown returns HTML", async () => {
    const res = await fetch(`${baseUrl}/guide/actions`, {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("generated reference data", () => {
  test("reference JSON is up to date with backend source", async () => {
    const dataDir = resolve(docsDir, ".vitepress", "data");
    const files = ["actions.json", "initializers.json", "config.json"];

    // Read current files
    const before = new Map<string, string>();
    for (const f of files) {
      const path = resolve(dataDir, f);
      if (existsSync(path)) {
        before.set(f, readFileSync(path, "utf-8"));
      }
    }

    // Re-generate
    const proc = Bun.spawn(["bun", "run", "generate"], {
      cwd: docsDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    // Compare
    const stale: string[] = [];
    for (const f of files) {
      const path = resolve(dataDir, f);
      if (existsSync(path)) {
        const after = readFileSync(path, "utf-8");
        if (before.get(f) !== after) stale.push(f);
      }
    }
    expect(stale).toEqual([]);
  });
});
