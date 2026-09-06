import "./styles.css";
import { getSystemHealth, type SystemHealth } from "./api.js";
import { mountBundleImportPanel } from "./bundle-import-panel.js";
import { mountLibraryPanel } from "./library-panel.js";
import { mountOrientationPanel } from "./orientation-panel.js";
import { escapeHtml } from "./html.js";

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("missing #app root");
const app: HTMLDivElement = root;

function healthBadge(health: SystemHealth | null): string {
  if (health === null) return '<span class="status status--pending">checking</span>';
  const state = health.ready ? "ready" : "blocked";
  return `<span class="status status--${state}">${state}</span>`;
}

function displayText(
  value: string | null | undefined,
  fallback: string,
): string {
  return escapeHtml(value ?? fallback);
}

function render(health: SystemHealth | null): void {
  app.innerHTML = `
    <header class="topbar">
      <div><strong>Eliot Research</strong><span class="generation">${displayText(health?.deployment_generation, "unknown generation")}</span></div>
      <span id="health-badge">${healthBadge(health)}</span>
    </header>
    <main class="workspace">
      <aside class="panel panel--corpus">
        <div id="library"></div>
        <nav>${["Research Wiki", "Reports"].map((item) => `<button disabled>${item}</button>`).join("")}</nav>
      </aside>
      <section class="panel panel--investigation">
        <div id="bundle-import"></div>
        <hr>
        <div id="corpus-lens"></div>
      </section>
      <aside class="panel panel--evidence">
        <h2>Evidence</h2>
        <dl>
          <dt>Core schema</dt><dd id="core-generation">${displayText(health?.core_schema_generation, "not applied")}</dd>
          <dt>Search schema</dt><dd id="search-generation">${displayText(health?.search_schema_generation, "not applied")}</dd>
          <dt>Coverage</dt><dd>not calculated</dd>
          <dt>Connector</dt><dd>not qualified</dd>
        </dl>
      </aside>
    </main>
  `;
  const lens = app.querySelector<HTMLElement>("#corpus-lens");
  const importer = app.querySelector<HTMLElement>("#bundle-import");
  const orientation = lens ? mountOrientationPanel(lens) : undefined;
  const library = app.querySelector<HTMLElement>("#library");
  const cleanups = [orientation, importer ? mountBundleImportPanel(importer) : undefined,
    library ? mountLibraryPanel(library, (id) => orientation?.selectSource(id)) : undefined];
  window.addEventListener("pagehide", () => cleanups.forEach((cleanup) => cleanup?.()), { once: true });
}

function updateHealth(health: SystemHealth): void {
  const badge = app.querySelector("#health-badge");
  if (badge) badge.innerHTML = healthBadge(health);
  for (const [selector, text] of [[".generation", health.deployment_generation],
    ["#core-generation", health.core_schema_generation ?? "not applied"],
    ["#search-generation", health.search_schema_generation ?? "not applied"]] as const) {
    const node = app.querySelector(selector); if (node) node.textContent = text;
  }
}

window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
render(null);
void getSystemHealth().then(updateHealth).catch(() => updateHealth({
  ready: false,
  deployment_generation: "unreachable",
  core_schema_generation: null,
  search_schema_generation: null,
  blocking_reason_codes: ["HEALTH_ENDPOINT_UNREACHABLE"],
  checked_at: new Date().toISOString(),
}));

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
