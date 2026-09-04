import "./styles.css";
import { getSystemHealth, type SystemHealth } from "./api.js";
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

function blockingReasons(health: SystemHealth | null): string {
  const reasons = health?.blocking_reason_codes ?? [];
  return reasons.length === 0
    ? "No schema blockers reported"
    : reasons.map(escapeHtml).join(", ");
}

function render(health: SystemHealth | null): void {
  app.innerHTML = `
    <header class="topbar">
      <div><strong>Eliot Research</strong><span class="generation">${displayText(health?.deployment_generation, "unknown generation")}</span></div>
      ${healthBadge(health)}
    </header>
    <main class="workspace">
      <aside class="panel panel--corpus">
        <h2>Corpus</h2>
        <nav>${["Projects", "Sources", "Corpus Lens", "Research Wiki", "Reports"].map((item) => `<button disabled>${item}</button>`).join("")}</nav>
      </aside>
      <section class="panel panel--investigation">
        <div class="panel-title"><h2>Investigation</h2><span>durable research ledger</span></div>
        <div class="empty-state">
          <strong>Implementation scaffold is active.</strong>
          <p>Research routes remain fail-closed until their work packets pass T0–T5.</p>
          <code>${blockingReasons(health)}</code>
        </div>
      </section>
      <aside class="panel panel--evidence">
        <h2>Evidence</h2>
        <dl>
          <dt>Core schema</dt><dd>${displayText(health?.core_schema_generation, "not applied")}</dd>
          <dt>Search schema</dt><dd>${displayText(health?.search_schema_generation, "not applied")}</dd>
          <dt>Coverage</dt><dd>not calculated</dd>
          <dt>Connector</dt><dd>not qualified</dd>
        </dl>
      </aside>
    </main>
  `;
}

render(null);
void getSystemHealth().then(render).catch(() => render({
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
