<script setup>
import { onMounted, ref } from "vue";

const releases = ref([]);
const loading = ref(true);
const error = ref(null);

const GITHUB_API = "https://api.github.com/repos/actionhero/keryx/releases";

onMounted(async () => {
  try {
    const res = await fetch(GITHUB_API, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    releases.value = await res.json();
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function renderBody(body) {
  if (!body) return "";
  return (
    body
      // PR links: move "#NNN" badge to front of each list item
      .replace(
        /^\* (.+?) by @\S+ in https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/gm,
        '* <a href="https://github.com/actionhero/keryx/pull/$2" target="_blank" rel="noopener" class="pr-link">#$2</a> $1',
      )
      // Full Changelog: render as a compact badge
      .replace(
        /\*\*Full Changelog\*\*: (https:\/\/github\.com\/[^/]+\/[^/]+\/compare\/(\S+))/g,
        '<a href="$1" target="_blank" rel="noopener" class="diff-badge">$2</a>',
      )
      // Generic markdown links
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>',
      )
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/^## (.+)$/gm, '<h3 class="changelog-section-title">$1</h3>')
      .replace(/^\* (.+)$/gm, "<li>$1</li>")
      .replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
      .replace(/\n\n/g, "<br>")
  );
}
</script>

<template>
  <div class="changelog">
    <div v-if="loading" class="changelog-loading">Loading releases...</div>
    <div v-else-if="error" class="changelog-error">
      <p>Failed to load releases from GitHub.</p>
      <p class="error-detail">{{ error }}</p>
      <p>
        <a
          href="https://github.com/actionhero/keryx/releases"
          target="_blank"
          rel="noopener"
        >
          View releases on GitHub →
        </a>
      </p>
    </div>
    <div v-else>
      <div
        v-for="(release, index) in releases"
        :key="release.id"
        class="changelog-release"
        :class="{ 'is-latest': index === 0 }"
      >
        <span class="timeline-dot" />
        <div class="release-header">
          <a
            :href="release.html_url"
            target="_blank"
            rel="noopener"
            class="release-tag"
          >
            {{ release.tag_name }}
          </a>
          <span class="release-date">
            {{ formatDate(release.published_at) }}
          </span>
        </div>
        <div class="release-body" v-html="renderBody(release.body)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.changelog {
  max-width: 740px;
  margin: 0 auto;
  padding: 0 24px;
}

.changelog-loading {
  text-align: center;
  padding: 48px 0;
  color: var(--vp-c-text-2);
}

.changelog-error {
  text-align: center;
  padding: 48px 0;
  color: var(--vp-c-text-2);
}

.error-detail {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.85rem;
  color: var(--vp-c-danger-1);
}

.changelog-release {
  position: relative;
  padding: 0 0 32px 36px;
}

/* Vertical timeline line */
.changelog-release::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 12px;
  bottom: 0;
  width: 2px;
  background: var(--vp-c-divider);
}

.changelog-release:last-child::before {
  display: none;
}

/* Timeline dot */
.timeline-dot {
  position: absolute;
  left: 0;
  top: 4px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--vp-c-divider);
  border: 2px solid var(--vp-c-bg);
  box-shadow: 0 0 0 2px var(--vp-c-divider);
}

.changelog-release.is-latest .timeline-dot {
  background: var(--vp-c-brand-1);
  box-shadow: 0 0 0 2px var(--vp-c-brand-1);
}

.release-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}

.release-tag {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.release-tag:hover {
  text-decoration: underline;
}

.release-date {
  font-size: 0.85rem;
  color: var(--vp-c-text-3);
}

.release-body {
  color: var(--vp-c-text-2);
  line-height: 1.7;
}

.release-body :deep(ul) {
  list-style: disc;
  padding-left: 20px;
  margin: 8px 0;
}

.release-body :deep(li) {
  margin: 4px 0;
}

.release-body :deep(a) {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.release-body :deep(a:hover) {
  text-decoration: underline;
}

.release-body :deep(.pr-link) {
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  font-weight: 600;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white) !important;
  padding: 1px 7px;
  border-radius: 10px;
  text-decoration: none;
  margin-right: 4px;
  vertical-align: baseline;
}

.release-body :deep(.pr-link:hover) {
  background: var(--vp-c-brand-2);
  text-decoration: none;
}

.release-body :deep(.diff-badge) {
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
  color: var(--vp-c-text-2) !important;
  border: 1px solid var(--vp-c-divider);
  padding: 2px 10px;
  border-radius: 12px;
  text-decoration: none;
}

.release-body :deep(.diff-badge:hover) {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1) !important;
  text-decoration: none;
}

.release-body :deep(.changelog-section-title) {
  font-size: 1rem;
  font-weight: 600;
  margin: 16px 0 8px;
  color: var(--vp-c-text-1);
}
</style>
