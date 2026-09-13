import "./styles.css";
import { ApiRequestError, getSystemHealth, type GoogleExternalTransport, type SystemHealth } from "./api.js";
import { mountBundleImportPanel } from "./bundle-import-panel.js";
import { mountGoogleOAuthPanel } from "./google-oauth-panel.js";
import { mountLibraryPanel } from "./library-panel.js";
import { mountOrientationPanel } from "./orientation-panel.js";
import { mountRetrievalPanel } from "./retrieval-panel.js";
import { mountEvidenceRail } from "./evidence-rail.js";
import { mountExhaustiveWorkflowPanel } from "./exhaustive-workflow-panel.js";
import { mountResearchRunPanel } from "./research-run-panel.js";
import { mountRawFilePanel } from "./raw-file-panel.js";
import { mountMcpClientDiagnosticPanel } from "./mcp-client-diagnostic-panel.js";
import { mountErasurePanel } from "./erasure-panel.js";
import { mountSourceNamespacePanel } from "./source-namespace-panel.js";
import { escapeHtml } from "./html.js";
import type { ResolvedEvidence, VersionedRef } from "@eliotr/contracts";

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("missing #app root");
const app: HTMLDivElement = root;

let googleOAuthCleanup: (() => void) | undefined;
let mountedGoogleTransport: GoogleExternalTransport | "unknown" | null = null;
type HealthLossReason = "initial-unavailable" | "connection-lost" | "generation-changed";
type HealthFailureKind = "network" | "access" | "server";
interface HealthFailure { readonly kind: HealthFailureKind; readonly code: string; readonly status: number; }

function classifyHealthFailure(error: unknown): HealthFailure {
  if (!(error instanceof ApiRequestError)) return { kind: "network", code: "API_UNREACHABLE", status: 0 };
  const code = /^[A-Z0-9_:-]{1,128}$/u.test(error.code) ? error.code : "API_REQUEST_FAILED";
  const status = Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : 0;
  const kind: HealthFailureKind = code === "API_UNREACHABLE" || code === "API_REQUEST_ABORTED"
    ? "network"
    : code.startsWith("ACCESS_") || status === 401 || status === 403 ? "access" : "server";
  return { kind, code, status };
}

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

function unavailableHealth(): SystemHealth {
  return {
    ready: false,
    deployment_generation: "unreachable",
    core_schema_generation: null,
    search_schema_generation: null,
    blocking_reason_codes: ["HEALTH_ENDPOINT_UNREACHABLE"],
    checked_at: new Date().toISOString(),
  };
}

function googleConnectorLabel(transport: GoogleExternalTransport | undefined): string {
  switch (transport) {
    case "drive-exchange": return "Drive exchange configured";
    case "gemini-mcp": return "Gemini MCP configured";
    case "disabled": return "Unavailable";
    default: return "Unknown";
  }
}

function healthSummary(health: SystemHealth | null, failure?: HealthFailure): string {
  if (health === null) return "Checking current deployment…";
  if (failure?.kind === "access") return "Sign-in verification unavailable. Retry the server check or sign in again.";
  if (failure?.kind === "network") return "Server unavailable. Retry server check.";
  if (failure !== undefined) return "Server check failed. Retry server check.";
  if (health.ready) return "Server ready. Workspace access is shown in Connections.";
  if (health.blocking_reason_codes.includes("HEALTH_ENDPOINT_UNREACHABLE")) return "Server unavailable. Retry server check.";
  return "Server responded. Workspace needs attention.";
}
function googleTransportExplanation(transport: GoogleExternalTransport | undefined): string {
  switch (transport) {
    case "drive-exchange": return "Google Drive is configured. Use the setup below.";
    case "gemini-mcp": return "Workspace access is configured. Use the client check when you need confirmation.";
    case "disabled": return "No workspace connection is configured here.";
    default: return "Workspace connection status is unknown.";
  }
}
function googleConnectionStateLabel(transport: GoogleExternalTransport | undefined): string {
  switch (transport) {
    case "drive-exchange":
    case "gemini-mcp": return "Configured";
    case "disabled": return "Unavailable";
    default: return "Unknown";
  }
}
function healthDetails(health: SystemHealth | null, failure?: HealthFailure): string {
  if (health === null) return "Health check pending.";
  const reasons = health.blocking_reason_codes.length === 0
    ? "None"
    : health.blocking_reason_codes.map((code) => escapeHtml(code)).join(", ");
  const requestFailure = failure === undefined ? "" : `<span>Request: ${escapeHtml(failure.code)} (${failure.status === 0 ? "no response" : String(failure.status)})</span>`;
  return `<span>Generation: ${displayText(health.deployment_generation, "Unknown")}</span><span>Codes: ${reasons}</span><span>Checked: ${displayText(health.checked_at, "Unknown")}</span>${requestFailure}`;
}

function renderGoogleConnector(health: SystemHealth | null): void {
  const host = app.querySelector<HTMLElement>("#google-oauth");
  if (!host) return;
  const transport = health?.google_external_transport;
  const mode: GoogleExternalTransport | "unknown" = transport ?? "unknown";
  if (mode === mountedGoogleTransport) return;
  googleOAuthCleanup?.();
  googleOAuthCleanup = undefined;
  host.replaceChildren();
  mountedGoogleTransport = mode;
  if (mode === "drive-exchange") googleOAuthCleanup = mountGoogleOAuthPanel(host);
}

function render(health: SystemHealth | null): void {
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="/" aria-label="Eliot Research home"><span class="brand-mark">E</span><span>Eliot Research</span></a>
      <div class="topbar-meta"><span class="workspace-label">PRIVATE WORKSPACE</span><span id="health-badge">${healthBadge(health)}</span></div>
    </header>
    <div class="health-strip" role="status" aria-live="polite">
      <span class="health-dot" aria-hidden="true"></span><strong>Owner API</strong>
      <span id="health-summary">${healthSummary(health)}</span>
      <span class="health-generation">${displayText(health?.deployment_generation, "generation pending")}</span>
      <details class="health-details"><summary>Details</summary><div id="health-details" class="health-details-content">${healthDetails(health)}</div></details>
    </div>
    <main class="workspace" aria-label="Research workspace">
      <aside class="panel panel--corpus" aria-label="Research navigation">
        <div class="sidebar-heading"><span class="eyebrow">Workspace</span></div>
        <nav class="workspace-nav" aria-label="Primary">
          <button class="nav-item nav-item--active" type="button" data-nav-target="#library" aria-controls="sources-view" aria-current="page"><span class="nav-icon">⌂</span><span>Sources</span></button>
          <button class="nav-item" type="button" data-nav-target="#research-card" aria-controls="research-view"><span class="nav-icon">⌕</span><span>Research</span></button>
          <button class="nav-item" type="button" data-nav-target="#connections-card" aria-controls="connections-card"><span class="nav-icon">◌</span><span>Connections</span></button>
        </nav>
        <button class="source-chooser-toggle" type="button" data-source-chooser-toggle aria-controls="library" aria-expanded="false"><span>Choose a source</span><span data-source-chooser-state>Show list</span></button>
        <div id="library"></div>
      </aside>
      <section class="panel panel--investigation" aria-label="Investigation workspace">
        <div class="content-heading"><div><span class="eyebrow" data-workspace-eyebrow>Sources</span><h1 data-workspace-title>Sources</h1><p class="lede" data-workspace-lede>Import or select admitted sources, then open Corpus Lens for structure and readiness.</p></div><div class="content-actions"><span class="profile-chip" data-workspace-owner-profile>E0 · owner read</span><button class="button button--quiet" type="button" data-refresh>Refresh</button></div></div>
        <section id="sources-view" class="workspace-view" data-workspace-view="sources" tabindex="-1" aria-label="Sources">
          <div class="workspace-cards">
            <article class="intro-card"><div class="intro-card-mark">◎</div><div><strong>Start with your sources</strong><p>Import a folder or choose an admitted source from the Library before opening its structure.</p><div class="intro-card-actions"><button class="button button--quiet workspace-jump" type="button" data-nav-target="#corpus-lens-card">Open Corpus Lens</button></div></div></article>
          </div>
          <div class="tool-stack">
            <section class="tool-card tool-card--import"><div id="source-namespace"></div><div class="tool-divider"></div><div id="raw-upload"></div><div class="tool-divider"></div><div id="bundle-import"></div></section>
            <section class="tool-card" id="corpus-lens-card"><div id="corpus-lens"></div></section>
            <details class="tool-card"><summary>Delete selected document</summary><div id="erasure"></div></details>
          </div>
        </section>
        <section id="research-view" class="workspace-view" data-workspace-view="research" tabindex="-1" aria-label="Research" hidden>
          <div class="workspace-cards">
            <article class="intro-card"><div class="intro-card-mark">⌕</div><div><strong>Ask across selected sources</strong><p>Run a bounded search or research workflow, then open only evidence that resolves against the admitted revision.</p></div></article>
            <div class="mini-grid"><div class="mini-stat"><span class="eyebrow">Coverage</span><strong id="coverage">Not queried</strong><span id="coverage-note">Run Research to measure sampled resolution.</span></div><div class="mini-stat"><span class="eyebrow">Evidence</span><strong id="evidence-count">0 resolved</strong><span>Verified excerpts in this session.</span></div></div>
          </div>
          <div class="tool-stack">
            <section class="tool-card tool-card--research" id="research-card"><div id="retrieval"></div><div class="tool-divider"></div><div id="research-run"></div><div class="tool-divider"></div><div id="exhaustive-workflow"></div></section>
          </div>
        </section>
        <section id="connections-card" class="workspace-view" data-workspace-view="connections" tabindex="-1" aria-label="Connections" hidden>
          <div class="connection-stack">
            <article class="connection-card" id="connection-agent-card"><div id="mcp-client-diagnostic"></div></article>
            <article class="connection-card" id="connection-server-card">
              <div class="connection-heading"><div><span class="eyebrow">Server check</span><h2>Owner API</h2></div><span id="connection-server-state" class="connection-state connection-state--pending">Checking</span></div>
              <p id="connection-server-copy" class="connection-copy">Checking the server. This check covers API and schema readiness only.</p>
              <dl class="connection-facts"><dt>Deployment</dt><dd id="connection-deployment">generation pending</dd><dt>Core schema</dt><dd id="connection-core-generation">Unknown</dd><dt>Search schema</dt><dd id="connection-search-generation">Unknown</dd></dl>
              <details class="connection-details"><summary>Readback</summary><div id="connection-health-details" class="health-details-content">${healthDetails(health)}</div></details>
              <div class="connection-actions"><button class="button button--quiet" type="button" data-connection-refresh>Retry server check</button></div>
            </article>
            <article class="connection-card" id="connection-workspace-card">
              <div class="connection-heading"><div><span class="eyebrow">Workspace connection</span><h2>Google Drive</h2></div><span id="connection-transport-state" class="connection-state connection-state--unknown">Unknown</span></div>
              <p id="connection-transport-copy" class="connection-copy">${escapeHtml(googleTransportExplanation(health?.google_external_transport))}</p>
              <div class="connection-profile"><span class="eyebrow">Owner profile</span><strong>E0 · owner read</strong></div>
              <div id="google-oauth"></div>
            </article>
          </div>
          <details class="access-boundary"><summary>Access and privacy</summary><p>All reads resolve through the owner API. Private data is never cached in the browser.</p></details>
        </section>
      </section>
      <aside class="panel panel--evidence" aria-label="Evidence details">
        <div class="evidence-heading"><div><span class="eyebrow">Evidence details</span><h2>Evidence</h2></div><span class="rail-status">No excerpt selected</span></div>
        <div id="evidence-empty" class="evidence-empty"><span class="evidence-glyph">✦</span><strong>Select an excerpt</strong><p>The source text and verification details will appear here.</p></div>
        <article id="evidence-detail" class="evidence-detail" hidden></article>
        <div class="system-facts"><span class="eyebrow">System facts</span><dl><dt>Core schema</dt><dd id="core-generation">${displayText(health?.core_schema_generation, "Unknown")}</dd><dt>Search schema</dt><dd id="search-generation">${displayText(health?.search_schema_generation, "Unknown")}</dd><dt>Connector</dt><dd id="connector-mode">${googleConnectorLabel(health?.google_external_transport)}</dd></dl></div>
      </aside>
    </main>
  `;
  const lens = app.querySelector<HTMLElement>("#corpus-lens");
  const importer = app.querySelector<HTMLElement>("#bundle-import");
  const rawUploadHost = app.querySelector<HTMLElement>("#raw-upload");
  let selectedNamespace: string | undefined;
  const namespaceSelected = (event: Event): void => {
    const id = (event as CustomEvent<{ sourceNamespaceId?: unknown }>).detail?.sourceNamespaceId;
    selectedNamespace = typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(id) ? id : undefined;
  };
  app.addEventListener("eliotr:namespace-selected", namespaceSelected);
  const namespaceHost = app.querySelector<HTMLElement>("#source-namespace");
  const namespacePanel = namespaceHost ? mountSourceNamespacePanel(namespaceHost, {
    deploymentGeneration: () => app.dataset.healthGeneration,
    healthReady: () => app.dataset.healthReady === "true",
  }) : undefined;
  app.dataset.healthReady = health?.ready === true ? "true" : "false";
  renderGoogleConnector(health);
  const orientation = lens ? mountOrientationPanel(lens) : undefined;
  const library = app.querySelector<HTMLElement>("#library");
  const sourcePanel = app.querySelector<HTMLElement>(".panel--corpus");
  const sourceChooserToggle = app.querySelector<HTMLButtonElement>("[data-source-chooser-toggle]");
  const sourceChooserState = app.querySelector<HTMLElement>("[data-source-chooser-state]");
  const sourceChooserViewport = window.matchMedia("(max-width: 720px)");
  let sourceChooserExpanded = !sourceChooserViewport.matches;
  const setSourceChooserExpanded = (expanded: boolean): void => {
    sourceChooserExpanded = expanded;
    if (sourcePanel) sourcePanel.dataset.sourceChooserCollapsed = expanded ? "false" : "true";
    sourceChooserToggle?.setAttribute("aria-expanded", String(expanded));
    if (sourceChooserState) sourceChooserState.textContent = expanded ? "Hide list" : "Show list";
  };
  const toggleSourceChooser = (): void => setSourceChooserExpanded(!sourceChooserExpanded);
  const handleSourceChooserViewport = (): void => setSourceChooserExpanded(!sourceChooserViewport.matches);
  sourceChooserToggle?.addEventListener("click", toggleSourceChooser);
  sourceChooserViewport.addEventListener("change", handleSourceChooserViewport);
  setSourceChooserExpanded(sourceChooserExpanded);
  const retrievalHost = app.querySelector<HTMLElement>("#retrieval");
  const retrieval = retrievalHost ? mountRetrievalPanel(retrievalHost, () => app.dataset.healthReady === "true") : undefined;
  const researchRunHost = app.querySelector<HTMLElement>("#research-run");
  const researchRun = researchRunHost ? mountResearchRunPanel(researchRunHost, () => app.dataset.healthGeneration, () => app.dataset.healthReady === "true") : undefined;
  const exhaustiveHost = app.querySelector<HTMLElement>("#exhaustive-workflow");
  const exhaustive = exhaustiveHost ? mountExhaustiveWorkflowPanel(exhaustiveHost, () => app.dataset.healthGeneration, () => app.dataset.healthReady === "true") : undefined;
  const diagnosticHost = app.querySelector<HTMLElement>("#mcp-client-diagnostic");
  const erasureHost = app.querySelector<HTMLElement>("#erasure");
  const erasure = erasureHost ? mountErasurePanel(erasureHost, {
    deploymentGeneration: () => app.dataset.healthGeneration,
    healthReady: () => app.dataset.healthReady === "true",
  }) : undefined;
  const diagnostic = diagnosticHost ? mountMcpClientDiagnosticPanel(diagnosticHost, {
    deploymentGeneration: () => app.dataset.healthGeneration,
    healthReady: () => app.dataset.healthReady === "true",
  }) : undefined;
  const evidenceEmpty = app.querySelector<HTMLElement>("#evidence-empty");
  const evidenceDetail = app.querySelector<HTMLElement>("#evidence-detail");
  const evidenceStatus = app.querySelector<HTMLElement>(".rail-status");
  const evidenceRail = evidenceEmpty && evidenceDetail && evidenceStatus
    ? mountEvidenceRail(evidenceEmpty, evidenceDetail, evidenceStatus) : undefined;
  const selectResearchEvidence = (event: Event): void => {
    const detail = (event as CustomEvent<{ scopeSnapshotRef?: VersionedRef; handleRef?: VersionedRef; excerptSha256?: string }>).detail;
    if (detail?.scopeSnapshotRef !== undefined && detail.handleRef !== undefined) evidenceRail?.selectHandle(detail.scopeSnapshotRef, detail.handleRef, detail.excerptSha256);
  };
  researchRunHost?.addEventListener("research:evidence-selected", selectResearchEvidence);
  type WorkspaceViewName = "sources" | "research" | "connections";
  type WorkspaceViewDefinition = { name: WorkspaceViewName; title: string; lede: string; sectionSelector: string; historyHash: string; anchorSelector: string };
  const sourcesView: WorkspaceViewDefinition = { name: "sources", title: "Sources", lede: "Import or select admitted sources, then open Corpus Lens for structure and readiness.", sectionSelector: "#sources-view", historyHash: "#library", anchorSelector: "#library" };
  const workspaceViews: Record<string, WorkspaceViewDefinition> = {
    "#library": sourcesView,
    "#corpus-lens-card": { ...sourcesView, anchorSelector: "#corpus-lens-card" },
    "#research-card": { name: "research", title: "Research", lede: "Search selected source bytes, inspect sampled coverage, and open only verified evidence.", sectionSelector: "#research-view", historyHash: "#research-card", anchorSelector: "#research-card" },
    "#connections-card": { name: "connections", title: "Connections", lede: "Check the server and workspace connection; client activity appears only after a manual check.", sectionSelector: "#connections-card", historyHash: "#connections-card", anchorSelector: "#connections-card" },
  };
  const locationSelector = (): string => {
    switch (window.location.hash) {
      case "#corpus-lens-card": return "#corpus-lens-card";
      case "#research":
      case "#research-card": return "#research-card";
      case "#connections":
      case "#connections-card": return "#connections-card";
      case "#sources":
      case "#library":
      default: return "#library";
    }
  };
  const resetWorkspaceScroll = (): void => {
    app.querySelector<HTMLElement>(".panel--investigation")?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  };
  const setWorkspaceView = (selector: string, options: { history?: boolean; focus?: boolean; anchor?: boolean } = {}): void => {
    const view = workspaceViews[selector] ?? sourcesView;
    const workspace = app.querySelector<HTMLElement>(".workspace");
    if (workspace) workspace.dataset.activeView = view.name;
    const ownerProfile = app.querySelector<HTMLElement>("[data-workspace-owner-profile]");
    if (ownerProfile) ownerProfile.hidden = view.name === "connections";
    if (view.name !== "sources" && sourceChooserViewport.matches) setSourceChooserExpanded(false);
    for (const item of app.querySelectorAll<HTMLButtonElement>('.workspace-nav [data-nav-target]')) {
      const active = workspaceViews[item.dataset.navTarget ?? ""]?.name === view.name;
      item.classList.toggle("nav-item--active", active);
      if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
    }
    for (const section of app.querySelectorAll<HTMLElement>("[data-workspace-view]")) {
      const active = section.dataset.workspaceView === view.name;
      section.hidden = !active;
      section.setAttribute("aria-hidden", active ? "false" : "true");
    }
    const eyebrow = app.querySelector<HTMLElement>("[data-workspace-eyebrow]");
    if (eyebrow) eyebrow.textContent = view.title;
    const title = app.querySelector<HTMLElement>("[data-workspace-title]");
    if (title) title.textContent = view.title;
    const lede = app.querySelector<HTMLElement>("[data-workspace-lede]");
    if (lede) lede.textContent = view.lede;
    if (options.history !== false && window.location.hash !== view.historyHash) {
      history.pushState({ eliotrWorkspaceView: view.name }, "", `${window.location.pathname}${window.location.search}${view.historyHash}`);
    }
    if (options.focus !== false) app.querySelector<HTMLElement>(view.sectionSelector)?.focus({ preventScroll: true });
    if (options.anchor === true) app.querySelector<HTMLElement>(view.anchorSelector)?.scrollIntoView({ behavior: "smooth", block: "start" });
    else resetWorkspaceScroll();
  };
  const handleFindInLibrary = (): void => {
    setSourceChooserExpanded(true);
    setWorkspaceView("#library", { history: true, focus: true });
  };
  rawUploadHost?.addEventListener("eliotr:find-in-library", handleFindInLibrary);
  for (const button of app.querySelectorAll<HTMLButtonElement>('.workspace-nav [data-nav-target]')) {
    button.addEventListener("click", () => {
      const selector = button.dataset.navTarget;
      if (selector) setWorkspaceView(selector);
    });
  }
  for (const button of app.querySelectorAll<HTMLButtonElement>(".workspace-jump[data-nav-target]")) {
    button.addEventListener("click", () => {
      const selector = button.dataset.navTarget;
      if (selector) setWorkspaceView(selector, { anchor: true });
    });
  }
  const handleLocationChange = (): void => setWorkspaceView(locationSelector(), { history: false });
  window.addEventListener("popstate", handleLocationChange);
  window.addEventListener("hashchange", handleLocationChange);
  setWorkspaceView(locationSelector(), { history: false, focus: false, anchor: false });
  const clearEvidenceRail = (resetSummary = true): void => {
    if (evidenceRail) evidenceRail.clear();
    else if (evidenceEmpty && evidenceDetail) { evidenceEmpty.hidden = false; evidenceDetail.hidden = true; evidenceDetail.replaceChildren(); }
    if (resetSummary) {
      const count = app.querySelector("#evidence-count");
      if (count) count.textContent = "0 resolved";
      const coverage = app.querySelector("#coverage");
      if (coverage) coverage.textContent = "Not queried";
      const coverageNote = app.querySelector("#coverage-note");
      if (coverageNote) coverageNote.textContent = "Run Research to measure sampled resolution.";
    }
  };
  const clearPrivateEvidence = (): void => { clearEvidenceRail(); retrieval?.clearPrivate(); researchRun?.clearPrivate(); exhaustive?.clearPrivate(); erasure?.clearPrivate(); libraryPanel?.clearPrivate(); };
  const sourceErased = (): void => { clearEvidenceRail(); retrieval?.clearPrivate(); researchRun?.clearPrivate(); exhaustive?.clearPrivate(); };
  erasureHost?.addEventListener("eliotr:source-erased", sourceErased);
  erasureHost?.addEventListener("eliotr:source-erasure-requested", sourceErased);
  const clearEvidenceOnEvent = (): void => clearPrivateEvidence();
  const clearEvidenceOnQueryStart = (): void => clearEvidenceRail();
  const refreshHealth = (): void => {
    const previousGeneration = app.querySelector(".health-generation")?.textContent;
    const refreshButtons = app.querySelectorAll<HTMLButtonElement>("[data-refresh], [data-connection-refresh]");
    refreshButtons.forEach((button) => { button.disabled = true; });
    void getSystemHealth().then((next) => {
      if (previousGeneration && previousGeneration !== "generation pending" && previousGeneration !== next.deployment_generation) clearPrivateEvidence();
      updateHealth(next);
    }).catch((error) => { clearPrivateEvidence(); updateHealth(unavailableHealth(), classifyHealthFailure(error));
    }).finally(() => { refreshButtons.forEach((button) => { button.disabled = false; }); });
  };
  app.querySelector<HTMLButtonElement>("[data-refresh]")?.addEventListener("click", refreshHealth);
  app.querySelector<HTMLButtonElement>("[data-connection-refresh]")?.addEventListener("click", refreshHealth);
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
    clearEvidenceRail(false);
  });
  retrievalHost?.addEventListener("retrieval:started", clearEvidenceOnQueryStart);
  researchRunHost?.addEventListener("research:started", clearEvidenceOnQueryStart);
  exhaustiveHost?.addEventListener("exhaustive:started", clearEvidenceOnQueryStart);
  exhaustiveHost?.addEventListener("exhaustive:completed", (event) => {
    const detail = (event as CustomEvent<{ matches: number; sections: number }>).detail;
    const coverage = app.querySelector("#coverage");
    if (coverage) coverage.textContent = `Complete · ${detail.sections} sections`;
    const coverageNote = app.querySelector("#coverage-note");
    if (coverageNote) coverageNote.textContent = `${detail.matches} exact match${detail.matches === 1 ? "" : "es"} in the reconciled scope.`;
  });
  app.addEventListener("eliotr:health-lost", clearPrivateEvidence);
  app.addEventListener("library:scope-changed", clearPrivateEvidence);
  window.addEventListener("offline", clearEvidenceOnEvent);
  window.addEventListener("eliotr:authorization-cleared", clearEvidenceOnEvent);
  retrievalHost?.addEventListener("retrieval:evidence-selected", (event) => {
    const evidence = (event as CustomEvent<{ evidence: ResolvedEvidence }>).detail.evidence;
    evidenceRail?.select(evidence, evidence.handle.scope_snapshot_ref);
  });
  const libraryPanel = library ? mountLibraryPanel(library, async (id, context) => {
    if (!id) { retrieval?.clearPrivate(); researchRun?.clearPrivate(); exhaustive?.clearPrivate(); erasure?.clearPrivate(); return; }
    erasure?.selectSource(id, context);
    if (!context?.sourceRevisionRef) {
      if (!orientation || !(await orientation.selectSource(id))) return false;
    }
    retrieval?.selectSource(id, context);
    researchRun?.selectSource(id, context);
    exhaustive?.selectSource(id);
    return true;
  }) : undefined;
  const cleanups = [orientation, retrieval, researchRun, exhaustive, diagnostic, erasure,
    () => erasureHost?.removeEventListener("eliotr:source-erased", sourceErased),
    () => erasureHost?.removeEventListener("eliotr:source-erasure-requested", sourceErased), importer ? mountBundleImportPanel(importer) : undefined,
    namespacePanel, () => app.removeEventListener("eliotr:namespace-selected", namespaceSelected),
    rawUploadHost ? mountRawFilePanel(rawUploadHost, { generation: () => app.dataset.healthGeneration, ready: () => app.dataset.healthReady === "true", sourceNamespace: () => selectedNamespace }) : undefined,
    libraryPanel];
  window.addEventListener("pagehide", () => { cleanups.forEach((cleanup) => cleanup?.()); googleOAuthCleanup?.(); googleOAuthCleanup = undefined; mountedGoogleTransport = null; evidenceRail?.dispose(); sourceChooserToggle?.removeEventListener("click", toggleSourceChooser); sourceChooserViewport.removeEventListener("change", handleSourceChooserViewport); rawUploadHost?.removeEventListener("eliotr:find-in-library", handleFindInLibrary); app.removeEventListener("library:scope-changed", clearPrivateEvidence); window.removeEventListener("offline", clearEvidenceOnEvent); window.removeEventListener("eliotr:authorization-cleared", clearEvidenceOnEvent); retrievalHost?.removeEventListener("retrieval:started", clearEvidenceOnQueryStart); researchRunHost?.removeEventListener("research:started", clearEvidenceOnQueryStart); exhaustiveHost?.removeEventListener("exhaustive:started", clearEvidenceOnQueryStart); app.removeEventListener("eliotr:health-lost", clearPrivateEvidence); window.removeEventListener("popstate", handleLocationChange); window.removeEventListener("hashchange", handleLocationChange); researchRunHost?.removeEventListener("research:evidence-selected", selectResearchEvidence); }, { once: true });
}

function updateHealth(health: SystemHealth, failure?: HealthFailure): void {
  const previousGeneration = app.dataset.healthGeneration;
  const previousReady = app.dataset.healthReady === "true";
  const healthObserved = app.dataset.healthObserved === "true";
  const endpointUnreachable = health.blocking_reason_codes.includes("HEALTH_ENDPOINT_UNREACHABLE");
  const generationChanged = !endpointUnreachable && previousGeneration !== undefined && previousGeneration !== "" && previousGeneration !== "unreachable" && previousGeneration !== health.deployment_generation;
  const reason: HealthLossReason | undefined = generationChanged
    ? "generation-changed"
    : !health.ready
      ? healthObserved && previousReady ? "connection-lost" : "initial-unavailable"
      : undefined;
  if (reason !== undefined) {
    app.dispatchEvent(new CustomEvent("eliotr:health-lost", { detail: { reason } }));
  }
  app.dataset.healthGeneration = health.deployment_generation;
  app.dataset.healthReady = health.ready ? "true" : "false";
  app.dataset.healthObserved = "true";
  renderGoogleConnector(health);
  const badge = app.querySelector("#health-badge");
  if (badge) badge.innerHTML = healthBadge(health);
  const summary = app.querySelector("#health-summary");
  if (summary) summary.textContent = healthSummary(health, failure);
  const details = app.querySelector("#health-details");
  if (details) details.innerHTML = healthDetails(health, failure);
  const refresh = app.querySelector<HTMLButtonElement>("[data-refresh]");
  if (refresh) refresh.textContent = health.ready ? "Refresh" : "Retry server check";
  const dot = app.querySelector(".health-dot");
  if (dot) dot.className = `health-dot health-dot--${health.ready ? "ready" : "blocked"}`;
  const generation = app.querySelector(".health-generation");
  if (generation) generation.textContent = health.deployment_generation;
  for (const [selector, text] of [[".generation", health.deployment_generation],
    ["#core-generation", health.core_schema_generation ?? "Unknown"],
    ["#search-generation", health.search_schema_generation ?? "Unknown"]] as const) {
    const node = app.querySelector(selector); if (node) node.textContent = text;
  }
  const connector = app.querySelector("#connector-mode");
  if (connector) connector.textContent = googleConnectorLabel(health.google_external_transport);
  const connectionServerState = app.querySelector<HTMLElement>("#connection-server-state");
  if (connectionServerState) {
    connectionServerState.className = `connection-state connection-state--${health.ready ? "ready" : "blocked"}`;
    connectionServerState.textContent = health.ready ? "Ready" : endpointUnreachable ? "Unavailable" : "Needs attention";
  }
  const connectionServerCopy = app.querySelector("#connection-server-copy");
  if (connectionServerCopy) connectionServerCopy.textContent = health.ready
    ? "Server is ready. This covers API and schema readiness only. Use Client connection check when you need a manual confirmation."
    : endpointUnreachable
      ? "Server unavailable. Retry the server check."
      : "Server responded. Workspace needs attention; see Details for blocking codes.";
  for (const [selector, text] of [["#connection-deployment", health.deployment_generation],
    ["#connection-core-generation", health.core_schema_generation ?? "Unknown"],
    ["#connection-search-generation", health.search_schema_generation ?? "Unknown"]] as const) {
    const node = app.querySelector(selector); if (node) node.textContent = text;
  }
  const connectionHealthDetails = app.querySelector("#connection-health-details");
  if (connectionHealthDetails) connectionHealthDetails.innerHTML = healthDetails(health, failure);
  const connectionTransportState = app.querySelector<HTMLElement>("#connection-transport-state");
  if (connectionTransportState) {
    const transportState = health.google_external_transport === undefined
      ? "unknown"
      : health.google_external_transport === "disabled" ? "disabled" : "configured";
    connectionTransportState.className = `connection-state connection-state--${transportState}`;
    connectionTransportState.textContent = googleConnectionStateLabel(health.google_external_transport);
  }
  const connectionTransportCopy = app.querySelector("#connection-transport-copy");
  if (connectionTransportCopy) connectionTransportCopy.textContent = googleTransportExplanation(health.google_external_transport);
  app.dispatchEvent(new Event("eliotr:health-updated", { bubbles: true }));
}

window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
render(null);
void getSystemHealth().then(updateHealth).catch((error) => updateHealth(unavailableHealth(), classifyHealthFailure(error)));

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
