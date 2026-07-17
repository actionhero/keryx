import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type StatusData = {
  name?: string;
  pid?: number;
  version?: string;
  uptime?: number;
  consumedMemoryMB?: number;
  healthy?: boolean;
  checks?: {
    database?: boolean;
    redis?: boolean;
  };
};

const app = new App({ name: "Server Status", version: "1.0.0" });
const element = (id: string) => document.getElementById(id)!;
let rendered = false;

function formatUptime(ms: number | undefined) {
  if (ms == null) return "—";
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m ${seconds % 60}s`;
}

function boolText(value: boolean | undefined) {
  if (value == null) return "—";
  return value ? "✓" : "✗";
}

function extractData(result: CallToolResult): StatusData | null {
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
    return result.structuredContent as StatusData;
  }

  const content = result.content[0];
  const text = content?.type === "text" ? content.text : undefined;
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as StatusData;
      }
    } catch {
      // The model-facing summary is not necessarily JSON.
    }
  }

  return null;
}

function render(data: StatusData | null) {
  if (!data) return false;
  element("name").textContent = data.name || "server";
  element("pid").textContent = data.pid != null ? String(data.pid) : "—";
  element("version").textContent = data.version || "—";
  element("uptime").textContent = formatUptime(data.uptime);
  element("memory").textContent =
    data.consumedMemoryMB != null ? `${data.consumedMemoryMB} MB` : "—";

  const health = element("health");
  if (data.healthy == null) {
    health.textContent = "—";
    health.className = "";
  } else {
    health.textContent = data.healthy ? "Healthy" : "Unhealthy";
    health.className = `pill ${data.healthy ? "healthy" : "unhealthy"}`;
  }
  element("database").textContent = boolText(data.checks?.database);
  element("redis").textContent = boolText(data.checks?.redis);

  const updated = element("updated");
  updated.className = "";
  updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  rendered = true;
  return true;
}

function showError(error: unknown) {
  const updated = element("updated");
  updated.className = "error";
  updated.textContent =
    error instanceof Error ? error.message : "Failed to load status";
}

async function fetchStatus() {
  const result = await app.callServerTool({ name: "status", arguments: {} });
  if (!render(extractData(result))) {
    throw new Error("Status tool returned no renderable data");
  }
}

// Register one-shot handlers before connect so the host cannot race them.
app.ontoolresult = (result) => {
  render(extractData(result));
};
app.onerror = showError;

element("refresh").addEventListener("click", async () => {
  element("refresh").setAttribute("disabled", "");
  try {
    await fetchStatus();
  } catch (error) {
    showError(error);
  } finally {
    element("refresh").removeAttribute("disabled");
  }
});

try {
  await app.connect();
  // Cursor may not replay the original result after the app handshake.
  if (!rendered) await fetchStatus();
} catch (error) {
  showError(error);
}
