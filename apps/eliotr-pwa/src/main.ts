import "./styles.css";
import { renderWorkspaceShell } from "./workspace-shell.js";
import { mountWorkspaceChrome } from "./workspace-chrome.js";
import { mountWorkspaceTheme } from "./workspace-theme.js";
import { getSystemHealth, type GoogleExternalTransport, type SystemHealth } from "./api.js";
import { mountBundleImportPanel } from "./bundle-import-panel.js";
import { mountGoogleOAuthPanel } from "./google-oauth-panel.js";
import { mountLibraryPanel } from "./library-panel.js";
import { mountProjectPanel } from "./project-panel.js";
import { mountClientGrantPanel } from "./client-grant-panel.js";
import { mountOrientationPanel } from "./orientation-panel.js";
import { mountRetrievalPanel } from "./retrieval-panel.js";
import { mountEvidenceRail } from "./evidence-rail.js";
import { mountExhaustiveWorkflowPanel } from "./exhaustive-workflow-panel.js";
import { mountResearchRunPanel } from "./research-run-panel.js";
import { mountResearchChangesPanel } from "./research-changes-panel.js";
import { mountWikiPanel } from "./wiki-panel.js";
import { mountRawFilePanel } from "./raw-file-panel.js";
import { SOURCE_VERSION_FORM_REQUESTED_EVENT } from "./raw-file-version-view.js";
import { mountMcpClientDiagnosticPanel } from "./mcp-client-diagnostic-panel.js";
import { mountErasurePanel } from "./erasure-panel.js";
import { mountSourceNamespacePanel } from "./source-namespace-panel.js";
import { mountResearchConfigurationPanel, type ResearchConfigurationStartState } from "./research-configuration-panel.js";
import { mountResearchProviderKeyPanel } from "./research-provider-key-panel.js";
import { mountResearchProviderKeyModelUsePanel } from "./research-provider-key-model-use-panel.js";
import { mountOwnerSessionPanel } from "./owner-session-panel.js";
import { createOwnerSessionLifecycle } from "./owner-session-lifecycle.js";
import { escapeHtml } from "./html.js";
import { classifyHealthFailure, type HealthFailure } from "./health-failure.js";
import type { ResolvedEvidence, VersionedRef } from "@eliotr/contracts";
import { bindSourceWorkspaceClientLifecycle } from "@eliotr/pwa-source-workspace";

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("missing #app root");
const app: HTMLDivElement = root;
const unbindSourceClientLifecycle = bindSourceWorkspaceClientLifecycle(window, app);
window.addEventListener("pagehide", unbindSourceClientLifecycle, { once: true });

let googleOAuthCleanup: (() => void) | undefined;
let healthController: AbortController | undefined;
let healthSerial = 0;
let pageClosed = false;
let mountedGoogleTransport: GoogleExternalTransport | "unknown" | null = null;
type HealthLossReason = "initial-unavailable" | "connection-lost" | "generation-changed";

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
  if (failure?.kind === "access") return "Sign-in could not be verified. Check Connections or sign in again.";
  if (failure?.kind === "network") return "Server unavailable. Retry server check.";
  if (failure !== undefined) return "Server check failed. Retry server check.";
  if (health.ready) return "Workspace is ready.";
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
  app.innerHTML = renderWorkspaceShell({
    healthBadge: healthBadge(health), healthSummary: healthSummary(health),
    healthDetails: healthDetails(health), workspaceConnection: escapeHtml(googleTransportExplanation(health?.google_external_transport)),
  });
  const themeCleanup = mountWorkspaceTheme(app);
  const lens = app.querySelector<HTMLElement>("#corpus-lens");
  const importer = app.querySelector<HTMLElement>("#bundle-import");
  const rawUploadHost = app.querySelector<HTMLElement>("#raw-upload");
  let selectedNamespace: string | undefined;
  let ownerSessionScopeSerial = 0;
  let ownerSessionScopeEpoch: number | undefined;
  const publishOwnerSessionScope = (verified: boolean): void => {
    ownerSessionScopeSerial += 1;
    ownerSessionScopeEpoch = verified ? ownerSessionScopeSerial : undefined;
    app.dispatchEvent(new Event("eliotr:owner-session-scope-changed"));
  };
  const ownerSessionLifecycle = createOwnerSessionLifecycle({
    deploymentGeneration: () => app.dataset.healthGeneration,
    healthReady: () => !pageClosed && app.dataset.healthReady === "true",
    onVerified: (session, deploymentGeneration) => {
      publishOwnerSessionScope(true);
      namespacePanel?.verifyOwnerSession(session, deploymentGeneration);
    },
    onCleared: () => {
      publishOwnerSessionScope(false);
      namespacePanel?.clearPrivate("Owner session verification ended. Workspace data was cleared.");
    },
    refreshReadPanes: () => { projectPanel?.refresh(); libraryPanel?.refresh(); researchRun?.refreshHistory(); },
  });
  const namespaceSelected = (event: Event): void => {
    const id = (event as CustomEvent<{ sourceNamespaceId?: unknown }>).detail?.sourceNamespaceId;
    selectedNamespace = typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(id) ? id : undefined;
  };
  app.addEventListener("eliotr:namespace-selected", namespaceSelected);
  const namespaceHost = app.querySelector<HTMLElement>("#source-namespace");
  const namespacePanel = namespaceHost ? mountSourceNamespacePanel(namespaceHost, {
    deploymentGeneration: () => app.dataset.healthGeneration,
    healthReady: () => app.dataset.healthReady === "true",
    onResumed: ownerSessionLifecycle.onResumed,
  }) : undefined;
  app.dataset.healthReady = health?.ready === true ? "true" : "false";
  renderGoogleConnector(health);
  const orientation = lens ? mountOrientationPanel(lens) : undefined;
  const library = app.querySelector<HTMLElement>("#library");
  const retrievalHost = app.querySelector<HTMLElement>("#retrieval");
  const retrieval = retrievalHost ? mountRetrievalPanel(retrievalHost, () => app.dataset.healthReady === "true") : undefined;
  let researchConfigurationStartState: ResearchConfigurationStartState | null = null;
  const researchRunHost = app.querySelector<HTMLElement>("#research-run");
  const researchRun = researchRunHost ? mountResearchRunPanel(researchRunHost, () => app.dataset.healthGeneration, () => app.dataset.healthReady === "true", () => researchConfigurationStartState?.configuration === "present" && researchConfigurationStartState.model_transport === "available" && researchConfigurationStartState.run_readiness !== "blocked") : undefined;
  const exhaustiveHost = app.querySelector<HTMLElement>("#exhaustive-workflow");
  const exhaustive = exhaustiveHost ? mountExhaustiveWorkflowPanel(exhaustiveHost, () => app.dataset.healthGeneration, () => app.dataset.healthReady === "true") : undefined;
  const researchChangesHost = app.querySelector<HTMLElement>("#research-changes");
  const researchChanges = researchChangesHost ? mountResearchChangesPanel(researchChangesHost, () => app.dataset.healthGeneration, () => app.dataset.healthReady === "true") : undefined;
  const researchConfigurationHost = app.querySelector<HTMLElement>("#research-configuration");
  const researchConfiguration = researchConfigurationHost ? mountResearchConfigurationPanel(researchConfigurationHost, {
    deploymentGeneration: () => app.dataset.healthGeneration,
    onStateChange: (state) => { researchConfigurationStartState = state; researchRun?.refreshAvailability(); },
  }) : undefined;
  const providerKeyHost = app.querySelector<HTMLElement>("#research-provider-key");
  const providerKeyPanel = providerKeyHost ? mountResearchProviderKeyPanel(providerKeyHost, {
    deploymentGeneration: () => app.dataset.healthGeneration,
    healthReady: () => app.dataset.healthReady === "true",
    ownerSessionScopeEpoch: () => ownerSessionScopeEpoch,
  }) : undefined;
  const providerKeyUseHost = app.querySelector<HTMLElement>("#research-provider-key-model-use");
  const providerKeyUsePanel = providerKeyUseHost ? mountResearchProviderKeyModelUsePanel(providerKeyUseHost, {
    deploymentGeneration: () => app.dataset.healthGeneration,
    healthReady: () => app.dataset.healthReady === "true",
    ownerSessionScopeEpoch: () => ownerSessionScopeEpoch,
  }) : undefined;
  const wikiHost = app.querySelector<HTMLElement>("#wiki");
  const wiki = wikiHost ? mountWikiPanel(wikiHost, () => app.dataset.healthGeneration, () => app.dataset.healthReady === "true") : undefined;
  const grantHost = app.querySelector<HTMLElement>("#client-grants");
  const clientGrants = grantHost ? mountClientGrantPanel(grantHost, {
    deploymentGeneration: () => app.dataset.healthGeneration,
    healthReady: () => app.dataset.healthReady === "true",
  }) : undefined;
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
  const ownerSessionHost = app.querySelector<HTMLElement>("#owner-session");
  const ownerSession = ownerSessionHost ? mountOwnerSessionPanel(ownerSessionHost, {
    deploymentGeneration: () => app.dataset.healthGeneration,
    healthReady: () => app.dataset.healthReady === "true",
    onVerified: ownerSessionLifecycle.onVerified,
    onCleared: ownerSessionLifecycle.onCleared,
    onExpired: ownerSessionLifecycle.onExpired,
  }) : undefined;
  const evidenceEmpty = app.querySelector<HTMLElement>("#evidence-empty");
  const evidenceDetail = app.querySelector<HTMLElement>("#evidence-detail");
  const evidenceStatus = app.querySelector<HTMLElement>(".rail-status");
  const evidenceRail = evidenceEmpty && evidenceDetail && evidenceStatus
    ? mountEvidenceRail(evidenceEmpty, evidenceDetail, evidenceStatus) : undefined;
  const workspaceChrome = mountWorkspaceChrome(app);
  const setSourceChooserExpanded = workspaceChrome.setSourceChooserExpanded;
  const selectResearchEvidence = (event: Event): void => {
    const detail = (event as CustomEvent<{ scopeSnapshotRef?: VersionedRef; handleRef?: VersionedRef; excerptSha256?: string }>).detail;
    if (detail?.scopeSnapshotRef !== undefined && detail.handleRef !== undefined) evidenceRail?.selectHandle(detail.scopeSnapshotRef, detail.handleRef, detail.excerptSha256);
  };
  app.addEventListener("research:evidence-selected", selectResearchEvidence);
  type WorkspaceViewName = "sources" | "research" | "wiki" | "connections";
  type WorkspaceViewDefinition = { name: WorkspaceViewName; title: string; lede: string; sectionSelector: string; historyHash: string; anchorSelector: string };
  const sourcesView: WorkspaceViewDefinition = { name: "sources", title: "Documents", lede: "Choose a document to read, or add a source to your library.", sectionSelector: "#sources-view", historyHash: "#library", anchorSelector: "#library" };
  const workspaceViews: Record<string, WorkspaceViewDefinition> = {
    "#library": sourcesView,
    "#corpus-lens-card": { ...sourcesView, anchorSelector: "#corpus-lens-card" },
    "#research-card": { name: "research", title: "Research", lede: "Ask your documents a question. Read the saved report alongside its sources.", sectionSelector: "#research-view", historyHash: "#research-card", anchorSelector: "#research-card" },
    "#wiki-card": { name: "wiki", title: "Wiki", lede: "Review saved Wiki proposals and read their current owner-authorized page text.", sectionSelector: "#wiki-view", historyHash: "#wiki-card", anchorSelector: "#wiki-card" },
    "#connections-card": { name: "connections", title: "Connections", lede: "Check the server and workspace connection; client activity appears only after a manual check.", sectionSelector: "#connections-card", historyHash: "#connections-card", anchorSelector: "#connections-card" },
    "#research-configuration-card": { name: "connections", title: "Connections", lede: "Check the server and workspace connection; client activity appears only after a manual check.", sectionSelector: "#connections-card", historyHash: "#research-configuration-card", anchorSelector: "#research-configuration-card" },
  };
  const locationSelector = (): string => {
    switch (window.location.hash) {
      case "#corpus-lens-card": return "#corpus-lens-card";
      case "#research":
      case "#research-card": return "#research-card";
      case "#wiki":
      case "#wiki-card": return "#wiki-card";
      case "#research-configuration-card": return "#research-configuration-card";
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
    if (view.name !== "sources") setSourceChooserExpanded(false);
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
    workspaceChrome.sync();
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
  const handleSourceVersionFormRequested = (): void => {
    const importCard = app.querySelector<HTMLDetailsElement>("#source-import-card");
    if (importCard) importCard.open = true;
    setSourceChooserExpanded(true);
    setWorkspaceView("#library", { history: true, focus: true });
  };
  rawUploadHost?.addEventListener("eliotr:find-in-library", handleFindInLibrary);
  rawUploadHost?.addEventListener(SOURCE_VERSION_FORM_REQUESTED_EVENT, handleSourceVersionFormRequested);
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
  let selectionSerial = 0;
  const clearPrivateEvidence = (researchNotice?: string, preserveIntent = false): void => {
    selectionSerial += 1;
    if (preserveIntent) researchRun?.suspendPrivate(); else researchRun?.clearPrivate(researchNotice);
    clearEvidenceRail(); retrieval?.clearPrivate(); exhaustive?.clearPrivate(); erasure?.clearPrivate(); ownerSession?.clearPrivate();
    projectPanel?.clearPrivate(); libraryPanel?.clearPrivate(); researchChanges?.clearPrivate(); wiki?.clearPrivate();
  };
  const sourceErased = (): void => { selectionSerial += 1; clearEvidenceRail(); retrieval?.clearPrivate(); researchRun?.clearPrivate(); exhaustive?.clearPrivate(); researchChanges?.clearPrivate(); wiki?.clearPrivate(); };
  erasureHost?.addEventListener("eliotr:source-erased", sourceErased);
  erasureHost?.addEventListener("eliotr:source-erasure-requested", sourceErased);
  const clearEvidenceOnEvent = (): void => {
    healthSerial += 1; healthController?.abort();
    app.querySelectorAll<HTMLButtonElement>("[data-refresh], [data-connection-refresh]").forEach((button) => { button.disabled = false; });
    updateHealth(unavailableHealth());
  };
  const clearEvidenceOnAuthorization = (): void => clearPrivateEvidence("Authorization changed. Sign in again, then refresh to check which sources remain permitted.");
  const clearEvidenceOnHealthLost = (event: Event): void => {
    const reason = (event as CustomEvent<{ reason?: unknown }>).detail?.reason;
    clearPrivateEvidence(undefined, reason === "connection-lost" || reason === "initial-unavailable");
  };
  const clearEvidenceOnScopeChange = (event: Event): void => {
    const detail = (event as CustomEvent<{ readonly reason?: unknown; readonly projectId?: unknown; readonly title?: unknown }>).detail;
    if (detail?.reason === "project-filter") {
      const projectId = typeof detail.projectId === "string" && detail.projectId.length > 0 ? detail.projectId : undefined;
      const title = projectId !== undefined && typeof detail.title === "string" && detail.title.length > 0 ? detail.title : undefined;
      researchRun?.setProject(projectId, title);
      return;
    }
    clearPrivateEvidence();
  };
  const clearResearchConfiguration = (): void => researchConfiguration?.clearPrivate();
  const refreshResearchConfiguration = (): void => researchConfiguration?.refresh();
  const refreshResearchChanges = (): void => researchChanges?.refresh();
  const refreshWiki = (): void => wiki?.refresh();
  const refreshProjects = (): void => projectPanel?.refresh();
  const refreshAfterSourceAdmission = (): void => {
    researchRun?.invalidateSourceRevision();
    wiki?.refresh(true);
    researchChanges?.refresh();
  };
  const clearEvidenceOnQueryStart = (): void => clearEvidenceRail();
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
  researchRunHost?.addEventListener("research:private-cleared", clearEvidenceOnQueryStart);
  exhaustiveHost?.addEventListener("exhaustive:started", clearEvidenceOnQueryStart);
  exhaustiveHost?.addEventListener("exhaustive:completed", (event) => {
    const detail = (event as CustomEvent<{ matches: number; sections: number }>).detail;
    const coverage = app.querySelector("#coverage");
    if (coverage) coverage.textContent = `Complete · ${detail.sections} sections`;
    const coverageNote = app.querySelector("#coverage-note");
    if (coverageNote) coverageNote.textContent = `${detail.matches} exact match${detail.matches === 1 ? "" : "es"} in the reconciled scope.`;
  });
  app.addEventListener("eliotr:health-lost", clearEvidenceOnHealthLost);
  app.addEventListener("eliotr:health-lost", clearResearchConfiguration);
  app.addEventListener("eliotr:health-updated", refreshResearchConfiguration);
  app.addEventListener("eliotr:health-updated", refreshResearchChanges);
  app.addEventListener("eliotr:health-updated", refreshWiki);
  app.addEventListener("eliotr:health-updated", refreshProjects);
  app.addEventListener("library:scope-changed", clearEvidenceOnScopeChange);
  window.addEventListener("offline", clearEvidenceOnEvent);
  window.addEventListener("online", refreshHealth);
  window.addEventListener("eliotr:authorization-cleared", clearEvidenceOnAuthorization);
  window.addEventListener("eliotr:raw-admission-completed", refreshAfterSourceAdmission);
  retrievalHost?.addEventListener("retrieval:evidence-selected", (event) => {
    const evidence = (event as CustomEvent<{ evidence: ResolvedEvidence }>).detail.evidence;
    evidenceRail?.select(evidence, evidence.handle.scope_snapshot_ref);
  });
  const projectHost = app.querySelector<HTMLElement>("#projects");
  const projectPanel = projectHost ? mountProjectPanel(projectHost, {
    deploymentGeneration: () => app.dataset.healthGeneration,
    healthReady: () => app.dataset.healthReady === "true",
    onOpenProject: (projectId) => libraryPanel?.openProject(projectId),
  }) : undefined;
  const libraryPanel = library ? mountLibraryPanel(library, async (id, context) => {
    // Empty Library callbacks clear protected selection, not retained Research intent.
    if (!id) { retrieval?.clearPrivate(); exhaustive?.clearPrivate(); erasure?.clearPrivate(); return; }
    const selection = selectionSerial;
    erasure?.selectSource(id, context);
    if (!context?.sourceRevisionRef) {
      if (!orientation || !(await orientation.selectSource(id))) return false;
    }
    if (selection !== selectionSerial || pageClosed || !navigator.onLine || app.dataset.healthReady !== "true") return false;
    if (!context?.sourceRevisionRef) {
      setSourceChooserExpanded(false);
      setWorkspaceView("#corpus-lens-card", { anchor: true });
    }
    retrieval?.selectSource(id, context);
    researchRun?.selectSource(id, context);
    exhaustive?.selectSource(id);
    return true;
  }) : undefined;
  const cleanups = [orientation, retrieval, researchRun, exhaustive, researchChanges, researchConfiguration, providerKeyPanel, providerKeyUsePanel, wiki, diagnostic, clientGrants, erasure, ownerSession, projectPanel,
    () => erasureHost?.removeEventListener("eliotr:source-erased", sourceErased),
    () => erasureHost?.removeEventListener("eliotr:source-erasure-requested", sourceErased), importer ? mountBundleImportPanel(importer) : undefined,
    namespacePanel, () => app.removeEventListener("eliotr:namespace-selected", namespaceSelected),
    rawUploadHost ? mountRawFilePanel(rawUploadHost, { generation: () => app.dataset.healthGeneration, ready: () => app.dataset.healthReady === "true", sourceNamespace: () => selectedNamespace }) : undefined,
    libraryPanel];
  window.addEventListener("pagehide", () => { pageClosed = true; healthSerial += 1; healthController?.abort(); cleanups.forEach((cleanup) => cleanup?.()); googleOAuthCleanup?.(); googleOAuthCleanup = undefined; mountedGoogleTransport = null; evidenceRail?.dispose(); workspaceChrome.dispose(); themeCleanup(); rawUploadHost?.removeEventListener("eliotr:find-in-library", handleFindInLibrary); rawUploadHost?.removeEventListener(SOURCE_VERSION_FORM_REQUESTED_EVENT, handleSourceVersionFormRequested); app.removeEventListener("library:scope-changed", clearEvidenceOnScopeChange); window.removeEventListener("offline", clearEvidenceOnEvent); window.removeEventListener("online", refreshHealth); window.removeEventListener("eliotr:authorization-cleared", clearEvidenceOnAuthorization); window.removeEventListener("eliotr:raw-admission-completed", refreshAfterSourceAdmission); retrievalHost?.removeEventListener("retrieval:started", clearEvidenceOnQueryStart); researchRunHost?.removeEventListener("research:started", clearEvidenceOnQueryStart); researchRunHost?.removeEventListener("research:private-cleared", clearEvidenceOnQueryStart); exhaustiveHost?.removeEventListener("exhaustive:started", clearEvidenceOnQueryStart); app.removeEventListener("eliotr:health-lost", clearEvidenceOnHealthLost); app.removeEventListener("eliotr:health-lost", clearResearchConfiguration); app.removeEventListener("eliotr:health-updated", refreshResearchConfiguration); app.removeEventListener("eliotr:health-updated", refreshResearchChanges); app.removeEventListener("eliotr:health-updated", refreshWiki); app.removeEventListener("eliotr:health-updated", refreshProjects); window.removeEventListener("popstate", handleLocationChange); window.removeEventListener("hashchange", handleLocationChange); app.removeEventListener("research:evidence-selected", selectResearchEvidence); }, { once: true });
}

function refreshHealth(): void {
  if (pageClosed) return;
  healthController?.abort();
  const mine = ++healthSerial;
  const local = new AbortController(); healthController = local;
  const buttons = app.querySelectorAll<HTMLButtonElement>("[data-refresh], [data-connection-refresh]");
  buttons.forEach((button) => { button.disabled = true; });
  void getSystemHealth(local.signal).then((health) => {
    if (mine === healthSerial && !pageClosed && navigator.onLine) updateHealth(health);
  }).catch((error: unknown) => {
    if (mine !== healthSerial || pageClosed || local.signal.aborted) return;
    const failure = classifyHealthFailure(error);
    if (failure.kind === "access") window.dispatchEvent(new Event("eliotr:authorization-cleared"));
    updateHealth(unavailableHealth(), failure);
  }).finally(() => {
    if (healthController === local) healthController = undefined;
    if (mine === healthSerial && !pageClosed) buttons.forEach((button) => { button.disabled = false; });
  });
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
  if (!endpointUnreachable) app.dataset.healthGeneration = health.deployment_generation;
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
refreshHealth();

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
