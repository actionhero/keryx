<script setup lang="ts">
import { onMounted, ref } from "vue";

const starCount = ref<number | null>(null);
const repoUrl = "https://github.com/actionhero/keryx";

onMounted(async () => {
  try {
    const res = await fetch("https://api.github.com/repos/actionhero/keryx");
    if (res.ok) {
      const data = await res.json();
      starCount.value = data.stargazers_count;
    }
  } catch {
    // silently fail — button still works without the count
  }
});
</script>

<template>
  <a :href="repoUrl" target="_blank" rel="noopener" class="github-star-btn">
    <svg
      class="github-icon"
      viewBox="0 0 16 16"
      width="18"
      height="18"
      fill="currentColor"
    >
      <path
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
    <span class="label">Star on GitHub</span>
    <span v-if="starCount !== null" class="count">{{ starCount }}</span>
  </a>
</template>

<style scoped>
.github-star-btn {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  border-radius: 8px;
  border: 1px solid rgba(207, 129, 40, 0.25);
  background: rgba(207, 129, 40, 0.06);
  color: var(--vp-c-text-1);
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
    "Courier New", monospace;
  font-size: 0.9rem;
  text-decoration: none;
  cursor: pointer;
  user-select: none;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.github-star-btn:hover {
  border-color: rgba(207, 129, 40, 0.45);
  background: rgba(207, 129, 40, 0.1);
}

.github-icon {
  flex-shrink: 0;
  color: var(--vp-c-brand-2);
}

.label {
  white-space: nowrap;
}

.count {
  color: var(--vp-c-text-3);
  font-size: 0.75rem;
  padding-left: 8px;
  border-left: 1px solid var(--vp-c-divider);
  transition: color 0.2s ease;
}

.github-star-btn:hover .count {
  color: var(--vp-c-brand-1);
}
</style>
