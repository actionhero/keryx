import { mountMcpApp } from "@keryxjs/mcp-app";
import type { ActionResponse } from "keryx";
import type { Status } from "../actions/status";

// Reuse the `status` action's response type instead of redefining it — the app renders
// exactly what the tool returns, fully typed end-to-end.
type StatusData = ActionResponse<Status>;

// No HTML file: the action declares only `mcp.ui.client`, so Keryx serves a default shell
// with a `<div id="root">`. We build the dashboard into it here.
const root = document.getElementById("root");
if (root) {
  root.innerHTML = `
    <style>
      main { max-width: 420px; margin: 0 auto; }
      header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      h1 { font-size: 1.1rem; margin: 0; }
      .pill { font-size: .75rem; padding: 2px 8px; border-radius: 999px; background: rgba(127,127,127,.18); }
      .pill.healthy { background: rgba(40,167,69,.22); color: #1e7e34; }
      .pill.unhealthy { background: rgba(220,53,69,.22); color: #c82333; }
      dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
      dt { color: rgba(127,127,127,.9); }
      dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
      footer { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
      button { padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; cursor: pointer; }
      button:disabled { opacity: .5; cursor: default; }
      #updated { font-size: .75rem; color: rgba(127,127,127,.9); }
      #updated.error { color: #c82333; }
    </style>
    <main>
      <header><h1>Server Status</h1><span id="name" class="pill">&mdash;</span></header>
      <dl>
        <dt>Health</dt><dd id="health">&mdash;</dd>
        <dt>Process ID</dt><dd id="pid">&mdash;</dd>
        <dt>Version</dt><dd id="version">&mdash;</dd>
        <dt>Uptime</dt><dd id="uptime">&mdash;</dd>
        <dt>Memory</dt><dd id="memory">&mdash;</dd>
        <dt>Database</dt><dd id="database">&mdash;</dd>
        <dt>Redis</dt><dd id="redis">&mdash;</dd>
      </dl>
      <footer><button id="refresh">Refresh</button><span id="updated"></span></footer>
    </main>`;
}

const element = (id: string) => document.getElementById(id);

function setText(id: string, text: string) {
  const el = element(id);
  if (el) el.textContent = text;
}

function formatUptime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m ${seconds % 60}s`;
}

function render(data: StatusData) {
  setText("name", data.name);
  setText("pid", String(data.pid));
  setText("version", data.version);
  setText("uptime", formatUptime(data.uptime));
  setText("memory", `${data.consumedMemoryMB} MB`);

  const health = element("health");
  if (health) {
    health.textContent = data.healthy ? "Healthy" : "Unhealthy";
    health.className = `pill ${data.healthy ? "healthy" : "unhealthy"}`;
  }
  setText("database", data.checks.database ? "✓" : "✗");
  setText("redis", data.checks.redis ? "✓" : "✗");

  const updated = element("updated");
  if (updated) {
    updated.className = "";
    updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
}

function showError(error: unknown) {
  const updated = element("updated");
  if (updated) {
    updated.className = "error";
    updated.textContent =
      error instanceof Error ? error.message : "Failed to load status";
  }
}

// Keryx bundles this file; mountMcpApp connects, renders the tool result, self-hydrates if
// the host doesn't replay it, and exposes refresh().
const { refresh } = await mountMcpApp<StatusData>({
  name: "Server Status",
  version: "1.0.0",
  render,
  onError: showError,
  refreshTool: { name: "status" },
});

const refreshButton = element("refresh");
refreshButton?.addEventListener("click", async () => {
  refreshButton.setAttribute("disabled", "");
  try {
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    refreshButton.removeAttribute("disabled");
  }
});
