<script setup>
import { useData } from "vitepress";
import { computed } from "vue";

const { page } = useData();
const mdUrl = computed(() => "/" + page.value.relativePath);
</script>

<template>
  <div class="markdown-link">
    <a :href="mdUrl" target="_blank">
      <span class="markdown-link-icon">🤖</span>
      View this page as Markdown
    </a>
  </div>
</template>

<style scoped>
.markdown-link {
  display: flex;
  justify-content: center;
  margin-top: 24px;
  margin-bottom: 24px;
}

.markdown-link a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  text-decoration: none;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 6px 14px;
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.markdown-link a:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-soft);
  background-color: var(--vp-c-brand-soft);
}

.markdown-link-icon {
  font-size: 14px;
}
</style>
