import "./styles.css";
import { getSystemHealth, type SystemHealth } from "./api.js";
import { mountBundleImportPanel } from "./bundle-import-panel.js";
import { mountGoogleOAuthPanel } from "./google-oauth-panel.js";
import { mountLibraryPanel } from "./library-panel.js";
import { mountOrientationPanel } from "./orientation-panel.js";
import { mountRetrievalPanel } from "./retrieval-panel.js";
import { escapeHtml } from "./html.js";
import type { ResolvedEvidence } from "@eliotr/contracts";

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
      <a class="brand" href="/" aria-label="Eliot Research home"><span class="brand-mark">E</span><span>Eliot Research</span></a>
      <div class="topbar-meta"><span class="workspace-label">PRIVATE WORKSPACE</span><span id="health-badge">${healthBadge(health)}</span></div>
    </header>
    <div class="health-strip" role="status" aria-live="polite">
      <span class="health-dot" aria-hidden="true"></span><strong>Owner API</strong>
      <span id="health-summary">Checking current deployment…</span>
      <span class="health-generation">${displayText(health?.deployment_generation, "generation pending")}</span>
    </div>
    <main class="workspace">
      <aside class="panel panel--corpus" aria-label="Research navigation">
        <div class="sidebar-heading"><span class="eyebrow">Workspace</span></div>
        <nav class="workspace-nav" aria-label="Primary">
          <button class="nav-item nav-item--active" type="button" data-nav-target="#library" aria-current="page"><span class="nav-icon">⌂</span><span>Library</span></button>
          <button class="nav-item" type="button" data-nav-target="#corpus-lens-card"><span class="nav-icon">◌</span><span>Corpus Lens</span></button>
          <button class="nav-item" type="button" data-nav-target="#research-card"><span class="nav-icon">⌕</span><span>Research</span></button>
        </nav>
        <div class="sidebar-section">
          <span class="eyebrow">Coming next</span>
          ${["Investigations", "Research Wiki", "Reports", "Jobs"].map((item) => `<button class="nav-item nav-item--muted" type="button" disabled><span class="nav-icon">·</span><span>${item}</span><span class="soon">Soon</span></button>`).join("")}
        </div>
        <div class="sidebar-footer"><span class="eyebrow">Access boundary</span><p>All reads resolve through the owner API. Private data is never cached in the browser.</p></div>
        <div id="library"></div>
      </aside>
      <section class="panel panel--investigation" aria-label="Investigation workspace">
        <div class="content-heading"><div><span class="eyebrow">Research desk</span><h1 data-workspace-title>Library overview</h1><p class="lede" data-workspace-lede>Browse admitted sources, orient yourself in the corpus, and resolve exact evidence when it is available.</p></div><div class="content-actions"><span class="profile-chip">E0 · owner read</span><button class="button button--quiet" type="button" data-refresh>Refresh</button></div></div>
        <div class="workspace-cards">
          <article class="intro-card"><div class="intro-card-mark">◎</div><div><strong>Start with your sources</strong><p>Choose a source from the Library to focus Corpus Lens and Research together.</p></div></article>
          <div class="mini-grid"><div class="mini-stat"><span class="eyebrow">Coverage</span><strong id="coverage">Not queried</strong><span id="coverage-note">Run Research to measure sampled resolution.</span></div><div class="mini-stat"><span class="eyebrow">Evidence</span><strong id="evidence-count">0 resolved</strong><span>Verified excerpts in this session.</span></div></div>
        </div>
        <div class="tool-stack">
          <section class="tool-card tool-card--import"><div id="bundle-import"></div></section>
          <section class="tool-card"><div id="google-oauth"></div></section>
          <section class="tool-card" id="corpus-lens-card"><div id="corpus-lens"></div></section>
          <section class="tool-card tool-card--research" id="research-card"><div id="retrieval"></div></section>
        </div>
      </section>
      <aside class="panel panel--evidence" aria-label="Evidence details">
        <div class="evidence-heading"><div><span class="eyebrow">Proof rail</span><h2>Evidence</h2></div><span class="rail-status">QUERY RESULT</span></div>
        <div id="evidence-empty" class="evidence-empty"><span class="evidence-glyph">✦</span><strong>Select a resolved excerpt</strong><p>Its revision, anchor, integrity and provenance will appear here.</p></div>
        <article id="evidence-detail" class="evidence-detail" hidden></article>
        <div class="system-facts"><span class="eyebrow">System facts</span><dl><dt>Core schema</dt><dd id="core-generation">${displayText(health?.core_schema_generation, "Unknown")}</dd><dt>Search schema</dt><dd id="search-generation">${displayText(health?.search_schema_generation, "Unknown")}</dd><dt>Connector</dt><dd>Not qualified</dd></dl></div>
      </aside>
    </main>
  `;
  const lens = app.querySelector<HTMLElement>("#corpus-lens");
  const importer = app.querySelector<HTMLElement>("#bundle-import");
  const googleOAuth = app.querySelector<HTMLElement>("#google-oauth");
  const orientation = lens ? mountOrientationPanel(lens) : undefined;
  const library = app.querySelector<HTMLElement>("#library");
  const retrievalHost = app.querySelector<HTMLElement>("#retrieval");
  const retrieval = retrievalHost ? mountRetrievalPanel(retrievalHost) : undefined;
  const workspaceViews: Record<string, { title: string; lede: string }> = {
    "#library": { title: "Library overview", lede: "Browse admitted sources, orient yourself in the corpus, and resolve exact evidence when it is available." },
    "#corpus-lens-card": { title: "Corpus Lens", lede: "Read the admitted source map and choose a source for focused investigation." },
    "#research-card": { title: "Research", lede: "Search resolved source bytes with a sampled coverage profile and inspect citation evidence." },
  };
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-nav-target]")) {
    button.addEventListener("click", () => {
      const selector = button.dataset.navTarget;
      if (!selector) return;
      for (const item of app.querySelectorAll<HTMLButtonElement>("[data-nav-target]")) {
        const active = item === button;
        item.classList.toggle("nav-item--active", active);
        if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
      }
      const view = workspaceViews[selector];
      if (view) {
        const title = app.querySelector("[data-workspace-title]");
        const lede = app.querySelector("[data-workspace-lede]");
        if (title) title.textContent = view.title;
        if (lede) lede.textContent = view.lede;
      }
      app.querySelector<HTMLElement>(selector)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  const clearEvidence = (): void => {
    const empty = app.querySelector<HTMLElement>("#evidence-empty");
    const evidence = app.querySelector<HTMLElement>("#evidence-detail");
    if (empty && evidence) { empty.hidden = false; evidence.hidden = true; evidence.replaceChildren(); }
  };
  // Coverage stays "sampled" until an exhaustive denominator is reconciled; the summary reports
  // what the last query actually resolved rather than implying a complete scope.
  retrievalHost?.addEventListener("retrieval:resolved", (event) => {
    const detail = (event as CustomEvent<{ resolved: number; bytes: number }>).detail;
    const node = app.querySelector("#coverage");
    if (node) node.textContent = `Sampled · ${detail.resolved} resolved`;
    const coverageNote = app.querySelector("#coverage-note");
    if (coverageNote) coverageNote.textContent = "A miss never proves corpus absence.";
    const count = app.querySelector("#evidence-count");
    if (count) count.textContent = `${detail.resolved} resolved`;
    clearEvidence();
  });
  app.addEventListener("library:scope-changed", clearEvidence);
  window.addEventListener("offline", clearEvidence);
  window.addEventListener("eliotr:authorization-cleared", clearEvidence);
  retrievalHost?.addEventListener("retrieval:evidence-selected", (event) => {
    const evidence = (event as CustomEvent<{ evidence: ResolvedEvidence }>).detail.evidence;
    const empty = app.querySelector<HTMLElement>("#evidence-empty");
    const detail = app.querySelector<HTMLElement>("#evidence-detail");
    if (!empty || !detail) return;
    empty.hidden = true;
    detail.hidden = false;
    const anchor = evidence.handle.anchor;
    const anchorText = anchor.kind === "normalized_byte_range" ? `bytes ${anchor.start}–${anchor.end}` : anchor.kind === "normalized_line_range" ? `lines ${anchor.start_line}–${anchor.end_line}` : anchor.kind;
    detail.innerHTML = `<span class="eyebrow">Resolved excerpt</span><h3>${escapeHtml(evidence.source_title ?? evidence.handle.source_revision_ref)}</h3><blockquote>${escapeHtml(evidence.exact_excerpt)}</blockquote><div class="evidence-meta"><span><b>Revision</b><code>${escapeHtml(evidence.handle.source_revision_ref)}</code></span><span><b>Anchor</b><code>${escapeHtml(anchorText)}</code></span><span><b>Excerpt SHA-256</b><code>${escapeHtml(evidence.handle.excerpt_sha256)}</code></span><span><b>Verification</b><code>${escapeHtml(evidence.verification_receipt_ref)}</code></span><span><b>Integrity</b><code>${escapeHtml(evidence.handle.terminal_state)} · ${escapeHtml(evidence.instruction_taint)}</code></span></div><p class="evidence-note">Pinned to the admitted revision. This panel mirrors the decoded query result; it does not issue a second verification request. Neighboring context is shown only when the API supplies a resolvable reference.</p>`;
  });
  const cleanups = [orientation, retrieval, importer ? mountBundleImportPanel(importer) : undefined,
    googleOAuth ? mountGoogleOAuthPanel(googleOAuth) : undefined,
    library ? mountLibraryPanel(library, (id) => {
      orientation?.selectSource(id);
      retrieval?.selectSource(id);
    }) : undefined];
  window.addEventListener("pagehide", () => { cleanups.forEach((cleanup) => cleanup?.()); app.removeEventListener("library:scope-changed", clearEvidence); window.removeEventListener("offline", clearEvidence); window.removeEventListener("eliotr:authorization-cleared", clearEvidence); }, { once: true });
}

function updateHealth(health: SystemHealth): void {
  const badge = app.querySelector("#health-badge");
  if (badge) badge.innerHTML = healthBadge(health);
  const summary = app.querySelector("#health-summary");
  if (summary) summary.textContent = health.ready ? "Ready · authenticated owner surface" : `Blocked · ${health.blocking_reason_codes.join(", ")}`;
  const dot = app.querySelector(".health-dot");
  if (dot) dot.className = `health-dot health-dot--${health.ready ? "ready" : "blocked"}`;
  const generation = app.querySelector(".health-generation");
  if (generation) generation.textContent = health.deployment_generation;
  for (const [selector, text] of [[".generation", health.deployment_generation],
    ["#core-generation", health.core_schema_generation ?? "Unknown"],
    ["#search-generation", health.search_schema_generation ?? "Unknown"]] as const) {
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

app.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLButtonElement && target.hasAttribute("data-refresh")) void getSystemHealth().then(updateHealth);
});

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
