<script setup>
import { withBase } from "vitepress";

const links = [
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
  {
    text: "Sitemap",
    href: "/sitemap.xml",
    note: "Every URL on this site",
  },
];
</script>

<template>
  <div class="NotFound">
    <p class="code">404</p>
    <h1 class="title">Page not found</h1>
    <div class="divider" />
    <blockquote class="quote">
      That page doesn't exist. Here's where to look next — this list is also
      available as machine-readable Markdown at
      <a :href="withBase('/llms.txt')">/llms.txt</a>.
    </blockquote>

    <ul class="link-list">
      <li v-for="link in links" :key="link.href">
        <a :href="withBase(link.href)" class="link">{{ link.text }}</a>
        <span class="note">— {{ link.note }}</span>
      </li>
    </ul>

    <div class="action">
      <a class="link home-link" :href="withBase('/')" aria-label="go to home"
        >Take me home →</a
      >
    </div>
  </div>
</template>

<style scoped>
.NotFound {
  padding: 64px 24px 96px;
  text-align: center;
  max-width: 640px;
  margin: 0 auto;
}

.code {
  line-height: 64px;
  font-size: 64px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.title {
  padding-top: 12px;
  letter-spacing: 2px;
  line-height: 20px;
  font-size: 20px;
  font-weight: 700;
}

.divider {
  margin: 24px auto 18px;
  width: 64px;
  height: 1px;
  background-color: var(--vp-c-divider);
}

.quote {
  margin: 0 auto;
  max-width: 512px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-2);
}

.quote a {
  color: var(--vp-c-brand-1);
  font-weight: 600;
}

.link-list {
  list-style: none;
  padding: 0;
  margin: 28px auto 0;
  max-width: 512px;
  text-align: left;
}

.link-list li {
  padding: 6px 0;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 14px;
}

.link {
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
  transition: color 0.25s;
}

.link:hover {
  color: var(--vp-c-brand-2);
}

.note {
  color: var(--vp-c-text-3);
}

.action {
  padding-top: 32px;
}

.home-link {
  display: inline-block;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 16px;
  padding: 6px 16px;
  font-size: 14px;
}
</style>
