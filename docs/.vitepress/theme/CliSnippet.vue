<script setup>
import { ref } from "vue";

const copied = ref(false);
const command = "bunx keryx new my-app";

function copyCommand() {
  navigator.clipboard.writeText(command);
  copied.value = true;
  setTimeout(() => {
    copied.value = false;
  }, 2000);
}
</script>

<template>
  <div class="cli-snippet" @click="copyCommand" role="button" tabindex="0">
    <span class="prompt">$</span>
    <span class="command">{{ command }}</span>
    <span class="copy-indicator">{{ copied ? "Copied!" : "Copy" }}</span>
  </div>
</template>

<style scoped>
.cli-snippet {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  border-radius: 8px;
  border: 1px solid rgba(207, 129, 40, 0.25);
  background: rgba(207, 129, 40, 0.06);
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
    "Courier New", monospace;
  font-size: 0.9rem;
  user-select: none;
}

.cli-snippet:hover {
  border-color: rgba(207, 129, 40, 0.45);
  background: rgba(207, 129, 40, 0.1);
}

.prompt {
  color: var(--vp-c-brand-2);
  font-weight: 600;
}

.command {
  color: var(--vp-c-text-1);
}

.copy-indicator {
  color: var(--vp-c-text-3);
  font-size: 0.75rem;
  padding-left: 8px;
  border-left: 1px solid var(--vp-c-divider);
  transition: color 0.2s ease;
}

.cli-snippet:hover .copy-indicator {
  color: var(--vp-c-brand-1);
}
</style>
