---
description: Auto-generated configuration reference — every config key, its environment variable, and default value.
---

<script setup>
import configData from '../.vitepress/data/config.json'
</script>

# Configuration

Every config key in the backend, auto-generated from source. Each key can be overridden via environment variable — the system checks for `ENV_VAR_NODEENV` first (e.g., `DATABASE_URL_TEST` when `NODE_ENV=test`), then `ENV_VAR`, then falls back to the default.

<div v-for="section in configData" :key="section.section">

## {{ section.section }}

<p>Source: <code>{{ section.sourceFile }}</code></p>

<table>
<thead>
<tr><th>Key</th><th>Environment Variable</th><th>Default</th></tr>
</thead>
<tbody>
<tr v-for="key in section.keys" :key="key.name">
<td><code>{{ key.name }}</code></td>
<td><code>{{ key.envVar }}</code></td>
<td><code>{{ key.defaultValue }}</code></td>
</tr>
</tbody>
</table>

</div>
