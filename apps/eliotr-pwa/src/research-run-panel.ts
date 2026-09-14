import { IdentifierSchema, ResearchWorkflowStageSchema, type ResearchWorkflowStage } from "@eliotr/contracts";
import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import { readResearchRunHistory, researchRunBody, readResearchArtifact, readReauthorizedResearchArtifact, readReauthorizedResearchArtifactSection, readResearchRunStatus, startResearchRun, type ResearchArtifactSectionCitationAuditClaim, type ResearchEngineStatus, type ResearchRunHistoryEntry, type ResearchRunHistoryView, type ResearchRunSavedDraft, type ResearchRunStatusView } from "./research-run-api.js"; import { readReauthorizedResearchArtifactSectionCitations } from "./research-run-reauthorization-api.js"; import { finishResearchStatusRead, readResearchStatusWithAuthorityRetry, shouldRetryResearchAuthority } from "./research-run-status-retry.js";
import { downloadResearchDraftMarkdown, type ResearchMarkdownSection } from "./research-markdown-download.js";
import type { ArtifactRevision } from "@eliotr/contracts";
import type { LibrarySelectionContext } from "./library-readiness-api.js";
const RESEARCH_STAGE_LABELS: Record<ResearchWorkflowStage, string> = {
  FREEZE_PROTOCOL_AND_SCOPE: "Preparing the research plan",
  ORIENT: "Understanding the question",
  INTERPRET: "Interpreting the question",
  COMPILE_OBLIGATIONS: "Defining what to check",
  PLAN: "Planning the search",
  RETRIEVE_BRANCHES: "Gathering sources",
  ACQUIRE_AND_CAPTURE: "Capturing source material",
  READ_AND_EXTRACT: "Reading source material",
  ANALYZE_BRANCHES: "Analyzing findings",
  COUNTER_SEARCH: "Checking for counterevidence",
  RECONCILE: "Reconciling findings",
  FREEZE_EVIDENCE: "Freezing verified evidence",
  SYNTHESIZE: "Drafting the report",
  VERIFY: "Verifying the draft",
  AUDIT_CLAIMS: "Checking report claims",
  RESOLVE_CITATIONS: "Resolving citations",
  CALCULATE_COVERAGE: "Measuring coverage",
  MATERIALIZE: "Saving the report",
};
const RESEARCH_STAGE_ORDER = ResearchWorkflowStageSchema.options;
const RESEARCH_STATUS_REFRESH_MS = 2_000;
const AUDIT_DISPOSITION_LABELS: Record<ResearchArtifactSectionCitationAuditClaim["disposition"], string> = {
  SUPPORTED: "Supported",
  PARTIALLY_SUPPORTED: "Partially supported",
  UNSUPPORTED: "Unsupported",
  CONTRADICTED: "Contradicted",
  NOT_VERIFIABLE_IN_SCOPE: "Could not be verified in this scope",
};
function message(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "RESEARCH_AGENT_NOT_CONFIGURED") return "Research agents are not configured on the server yet.";
    if (error.status === 401 || error.status === 403) return "This research run is no longer available for the current session.";
    if (error.status === 409) return "The Research run belongs to another deployment or its authority changed. Refresh the workspace.";
    if (error.retryable) return "The Research service is unavailable. Refresh to try again.";
    return "The Research run could not be read. Check the query and session.";
  }
  return "The Research run could not be read. Check the query and session.";
}
function statusText(view: ResearchRunStatusView): string {
  switch (view.execution_state) {
    case "ACTIVE": {
      const stage = RESEARCH_STAGE_ORDER[view.next_stage_index];
      const label = stage === undefined ? "Continuing through the research workflow" : RESEARCH_STAGE_LABELS[stage];
      if (view.engine_status === "errored") return failureText(view.failure) ?? "The research engine stopped before finishing. No answer is available.";
      if (view.engine_status === "terminated") return "The research engine was stopped. No answer is available.";
      if (view.engine_status === "complete") return "The research engine finished. The saved run is still being finalized.";
      if (view.engine_status === "unknown") return "Research execution status is unavailable. Refresh to check again.";
      if (view.engine_status === "paused") return `Research is paused. Current stage: ${label}. Refresh to check again.`;
      if (view.engine_status === "waiting" || view.engine_status === "waitingForPause") return `Research is waiting to continue. Current stage: ${label}. Status refreshes automatically.`;
      return `Research is processing. Current stage: ${label}. Status refreshes automatically.`;
    }
    case "CANCELLED": return "Research was cancelled. Answer unavailable.";
    case "ENGINE_COMPLETED": return view.answer.availability === "draft" ? "A draft report is ready for review." : "Processing finished. No answer has been generated.";
  }
}
function badgeText(view: ResearchRunStatusView): string {
  if (view.execution_state === "ACTIVE") {
    return view.engine_status === "errored" || view.engine_status === "terminated" ? "FAILED" : "RUNNING";
  }
  if (view.execution_state === "CANCELLED") return "CANCELLED";
  return view.answer.availability === "draft" ? "DRAFT" : "COMPLETE";
}
function idleBadgeText(ready: boolean): string {
  return ready ? "READY" : "WAITING";
}
function idleProgressText(ready: boolean): string {
  return ready ? "Ready to start a research run." : "Waiting for the current owner session.";
}
function failureText(failure: ResearchRunStatusView["failure"]): string | undefined {
  switch (failure?.code) {
    case "WORKFLOW_OUTPUT_CORRUPT":
      return "The model returned a result that did not match the required format. This run has no verified answer. Your saved reports are still available.";
    case "WORKFLOW_OUTPUT_UNAVAILABLE":
      return "The research result could not be read. This run has no verified answer. Your saved reports are still available.";
    case "WORKFLOW_EFFECT_UNCERTAIN":
      return "Research stopped before its result could be verified. Your saved reports are still available.";
    case "WORKFLOW_BUDGET_STOP":
      return "Research stopped before finishing within its execution window. Your saved reports are still available.";
    case "WORKFLOW_AUTHORITY_STALE":
      return "Research authority changed before this run finished. Your saved reports are still available.";
    case "RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED":
      return "Research access cannot be renewed because the server Read token is missing. An administrator must renew the connection.";
    case "RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE":
      return "Research policy has expired. An administrator must renew research access.";
    default:
      return undefined;
  }
}
function auditStatusText(claims: readonly ResearchArtifactSectionCitationAuditClaim[]): string {
  if (claims.some((claim) => claim.disposition === "NOT_VERIFIABLE_IN_SCOPE")) {
    return `${claims.length} claim assessments are recorded. Some claims could not be verified. Review the draft and its sources.`;
  }
  return `${claims.length} claim assessments are recorded. The verdicts describe the saved evidence; they do not mean every claim is true.`;
}
function historyStageText(view: ResearchRunStatusView): string {
  if (view.execution_state === "ACTIVE") {
    if (view.engine_status === "errored") return failureText(view.failure) ?? "Engine stopped before completion";
    if (view.engine_status === "terminated") return "Engine stopped";
    if (view.engine_status === "complete") return "Engine finished; saved state pending";
    if (view.engine_status === "unknown") return "Execution status unavailable";
    const stage = RESEARCH_STAGE_ORDER[view.next_stage_index];
    return stage === undefined ? "Continuing through the research workflow" : RESEARCH_STAGE_LABELS[stage];
  }
  if (view.execution_state === "CANCELLED") return "Cancelled";
  return view.answer.availability === "draft" ? "Draft available" : "Finished without a report";
}
function historyNoteText(view: ResearchRunStatusView): string {
  const stage = historyStageText(view);
  if (view.execution_state === "ENGINE_COMPLETED" && view.answer.availability === "draft") return stage;
  return `${stage} · ${view.answer.availability === "draft" ? "Draft available" : "No draft available"}`;
}
function historyStatusText(view: ResearchRunHistoryView): string {
  if (view.configuration_state === "MISSING") return "Research configuration is missing on the server. Install it before starting a research run.";
  if (view.runs.length === 0 && view.saved_drafts.length === 0) return "Configuration installed; run research to confirm execution. No saved runs are available yet.";
  const hasSavedDraft = view.saved_drafts.length > 0 || view.runs.some((entry) => entry.status.execution_state === "ENGINE_COMPLETED" && entry.status.answer.availability === "draft");
  return hasSavedDraft ? "Configuration installed; a saved draft is available below." : "Configuration installed; recent runs below show actual execution.";
}
function shouldPollEngine(status: ResearchEngineStatus | undefined): boolean {
  return status === undefined || status === "queued" || status === "running" || status === "paused" || status === "waiting" || status === "waitingForPause";
}
function historyDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function historyErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) return "Saved research is no longer available for this session.";
    if (error.retryable) return "Saved research is temporarily unavailable. Refresh to try again.";
  }
  return "Saved research could not be loaded. Refresh to try again.";
}
function decodeSectionBody(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ApiRequestError({ status: 502, code: "RESEARCH_ARTIFACT_SECTION_INVALID", message: "The report section is not valid UTF-8" }); }
}
function codeRef(value: string): HTMLElement {
  const code = document.createElement("code");
  code.textContent = value;
  return code;
}
function citationRefKey(ref: { readonly id: string; readonly revision: number }): string {
  return `${ref.id}:${ref.revision}`;
}
function sameArtifact(left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean {
  return left.id === right.id && left.revision === right.revision;
}
export function mountResearchRunPanel(
  element: HTMLElement,
  deploymentGeneration: () => string | undefined,
  healthReady: () => boolean = () => false,
  researchConfigurationReady: () => boolean = () => true,
): (() => void) & { clearPrivate(notice?: string): void; refreshAvailability(): void; selectSource(id: string, context?: LibrarySelectionContext): void } {
  element.innerHTML = `<div class="workflow-head"><div><span class="eyebrow">Research run</span><h2>Prepare a research run</h2></div><span class="workflow-badge" data-run-badge>${idleBadgeText(healthReady() && researchConfigurationReady())}</span></div>
    <p class="workflow-status workflow-progress-summary" data-run-progress aria-live="polite">${idleProgressText(healthReady() && researchConfigurationReady())}</p>
    <p class="workflow-copy">Start research and open a saved draft when one is available.</p>
    <form><label>Question<textarea name="query" rows="5" maxlength="4096" autocomplete="off" required placeholder="Ask a research question" style="width:100%;min-height:120px;padding:10px 11px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;font-size:13px;resize:vertical"></textarea></label>
    <label>Scope<select name="scope"><option value="library">Entire authorized Library</option><option value="selected" disabled>Selected source</option></select></label>
    <div class="workflow-actions"><button type="submit" class="button">Start research</button><button type="button" class="button button--quiet" data-run-refresh disabled>Refresh status</button></div></form>
    <section class="workflow-recovery" aria-labelledby="research-history-title"><div class="workflow-recovery-head"><div><span class="eyebrow">Saved research</span><h3 id="research-history-title">Recent research</h3></div><button type="button" class="button button--quiet" data-research-history-refresh disabled>Refresh</button></div>
      <p class="workflow-recovery-status" data-research-history-status>Recent research appears after the current session is ready.</p><div class="workflow-recovery-list" data-research-history-list></div></section>
    <div class="workflow-recovery"><label>Run ID<input data-workflow-id maxlength="128" autocomplete="off" placeholder="Paste a known run ID"></label><button type="button" class="button button--quiet" data-recover>Load status</button></div>
    <p class="workflow-status" role="status" aria-live="polite">${healthReady() ? "Ready when the current owner session is available." : "Waiting for the current owner session."}</p>
    <section data-run-result hidden></section>`;
  const form = element.querySelector<HTMLFormElement>("form");
  const badge = element.querySelector<HTMLElement>("[data-run-badge]");
  const progress = element.querySelector<HTMLElement>("[data-run-progress]");
  const query = element.querySelector<HTMLTextAreaElement>('textarea[name="query"]');
  const scope = element.querySelector<HTMLSelectElement>('select[name="scope"]');
  const selectedOption = scope?.querySelector<HTMLOptionElement>('option[value="selected"]');
  const submit = element.querySelector<HTMLButtonElement>('button[type="submit"]'); const refresh = element.querySelector<HTMLButtonElement>("[data-run-refresh]");
  const workflowInput = element.querySelector<HTMLInputElement>("[data-workflow-id]"); const recover = element.querySelector<HTMLButtonElement>("[data-recover]");
  const status = element.querySelector<HTMLElement>('[role="status"]'); const result = element.querySelector<HTMLElement>("[data-run-result]");
  const historyRefresh = element.querySelector<HTMLButtonElement>("[data-research-history-refresh]"); const historyStatus = element.querySelector<HTMLElement>("[data-research-history-status]");
  const historyList = element.querySelector<HTMLElement>("[data-research-history-list]");
  if (!form || !badge || !progress || !query || !scope || !selectedOption || !submit || !refresh || !workflowInput || !recover || !status || !result || !historyRefresh || !historyStatus || !historyList) throw new Error("Research run panel is incomplete");
  let serial = 0; let controller: AbortController | undefined;
  let workflowId: string | undefined; let workflowGeneration: string | undefined; let selectedSourceId: string | undefined;
  let previousBody = ""; let idempotencyKey = ""; let progressTimer: number | undefined;
  let lastExecutionState: ResearchRunStatusView["execution_state"] | undefined; let lastEngineStatus: ResearchEngineStatus | undefined; let lastAnswerAvailability: ResearchRunStatusView["answer"]["availability"] | undefined;
  let historyController: AbortController | undefined; let historySerial = 0; let historyGeneration: string | undefined; let historyView: Awaited<ReturnType<typeof readResearchRunHistory>> | undefined;
  const historyRows = new Map<string, HTMLElement>(); let disposed = false;
  const clearProgressTimer = (): void => {
    if (progressTimer !== undefined) { window.clearTimeout(progressTimer); progressTimer = undefined; }
  };
  const updateButtons = (): void => {
    const available = healthReady();
    const startAvailable = available && researchConfigurationReady();
    const busy = controller !== undefined;
    submit.disabled = !startAvailable || busy;
    recover.disabled = !available || busy;
    refresh.disabled = !available || busy || workflowId === undefined;
    historyRefresh.disabled = !available || historyController !== undefined;
  };
  const setReportActionsDisabled = (disabled: boolean): void => {
    result.querySelectorAll<HTMLButtonElement>(".research-report-actions > button, .research-citation-actions > button").forEach((button) => { button.disabled = disabled || button.dataset.reportActionUnavailable === "true"; });
  };
  const finishReportAction = (local: AbortController, renderSerial: number): void => {
    if (controller !== local) return;
    controller = undefined; if (disposed || renderSerial !== serial) return; setReportActionsDisabled(false); updateButtons();
  };
  const refreshAvailability = (): void => {
    badge.textContent = lastExecutionState === undefined
      ? idleBadgeText(healthReady() && researchConfigurationReady())
      : lastExecutionState === "ACTIVE"
        ? (lastEngineStatus === "errored" || lastEngineStatus === "terminated" ? "FAILED" : "RUNNING")
        : lastExecutionState === "CANCELLED" ? "CANCELLED" : lastAnswerAvailability === "draft" ? "DRAFT" : "COMPLETE";
    if (lastExecutionState === undefined) progress.textContent = idleProgressText(healthReady() && researchConfigurationReady());
    updateButtons();
  };
  const stop = (): void => {
    serial += 1;
    clearProgressTimer();
    controller?.abort();
    controller = undefined;
    lastExecutionState = undefined;
    lastEngineStatus = undefined;
    lastAnswerAvailability = undefined;
    updateButtons();
  };
  const clearHistoryRequest = (): void => {
    historySerial += 1;
    historyController?.abort();
    historyController = undefined;
    historyGeneration = undefined;
  };
  const clearHistory = (): void => {
    clearHistoryRequest();
    historyView = undefined;
    historyRows.clear();
    historyList.replaceChildren();
    historyStatus.textContent = "Recent research appears after the current session is ready.";
  };
  const clearPrivate = (notice = "Private research state cleared. Reconnect before starting or loading a run."): void => {
    stop(); clearHistory(); workflowId = undefined; workflowGeneration = undefined; selectedSourceId = undefined; previousBody = ""; idempotencyKey = "";
    workflowInput.value = ""; result.replaceChildren(); result.hidden = true; query.value = ""; scope.value = "library"; selectedOption.disabled = true;
    badge.textContent = idleBadgeText(healthReady() && researchConfigurationReady()); progress.textContent = idleProgressText(healthReady() && researchConfigurationReady());
    updateButtons(); status.textContent = notice;
  };
  const showUnavailableRun = (error: ApiRequestError): void => {
    clearPrivate();
    progress.textContent = "Saved research is unavailable.";
    status.textContent = `Saved research is unavailable. ${message(error)}`;
    console.warn("research_run_read_failed", JSON.stringify({ code: error.code, status: error.status }));
  };
  const onHealthUpdated = (): void => {
    const ready = healthReady();
    if (!ready) clearPrivate(); else { refreshAvailability(); scheduleStatusRefresh(true); loadHistory("automatic"); }
  };
  const onVisibilityChanged = (): void => {
    if (document.visibilityState === "hidden") {
      clearProgressTimer();
      if (historyController !== undefined) clearHistoryRequest();
        if (controller !== undefined) {
          serial += 1;
          controller.abort();
          controller = undefined;
          setReportActionsDisabled(false);
          updateButtons();
        }
      return;
    }
    scheduleStatusRefresh(true);
    if (healthReady()) loadHistory("automatic");
  };
  window.addEventListener("eliotr:health-updated", onHealthUpdated);
  document.addEventListener("visibilitychange", onVisibilityChanged);
  updateButtons();
  const scheduleStatusRefresh = (immediate = false): void => {
    clearProgressTimer();
    if (disposed || lastExecutionState !== "ACTIVE" || workflowId === undefined || controller !== undefined ||
        !shouldPollEngine(lastEngineStatus) || !healthReady() || !navigator.onLine || document.visibilityState === "hidden") return;
    progressTimer = window.setTimeout(() => {
      progressTimer = undefined;
      readStatus("automatic");
    }, immediate ? 0 : RESEARCH_STATUS_REFRESH_MS);
  };
  const renderHistory = (entry: ResearchRunHistoryEntry): HTMLElement => {
    const row = document.createElement("div"); row.className = "workflow-recovery-row";
    const open = document.createElement("button"); open.type = "button"; open.className = "workflow-recovery-item";
    const date = historyDate(entry.created_at); open.textContent = `Open research · ${date}`; open.setAttribute("aria-label", `Open saved research from ${date}`);
    open.onclick = () => {
      if (disposed || !open.isConnected || open.closest("[data-research-history-list]") !== historyList || !healthReady() || !navigator.onLine || historyView?.deployment_generation !== entry.status.deployment_generation) return;
      readStatus("history", entry.status.workflow_instance_id);
    };
    const note = document.createElement("p"); note.className = "workflow-recovery-note";
    note.textContent = historyNoteText(entry.status);
    row.append(open, note);
    historyRows.set(entry.status.workflow_instance_id, row);
    return row;
  };
  const renderSavedDraft = (draft: ResearchRunSavedDraft, generation: string): HTMLElement => {
    const row = document.createElement("div"); row.className = "workflow-recovery-row";
    const open = document.createElement("button"); open.type = "button"; open.className = "workflow-recovery-item";
    const date = historyDate(draft.created_at); open.textContent = `Open saved research · ${date}`; open.setAttribute("aria-label", `Open saved research draft from ${date}`);
    open.onclick = () => {
      if (disposed || !open.isConnected || open.closest("[data-research-history-list]") !== historyList || !healthReady() || !navigator.onLine || deploymentGeneration() !== generation || historyView?.deployment_generation !== generation) return;
      readSavedDraft(draft);
    };
    const note = document.createElement("p"); note.className = "workflow-recovery-note"; note.textContent = "Draft available";
    row.append(open, note);
    return row;
  };
  const renderHistoryList = (view: Awaited<ReturnType<typeof readResearchRunHistory>>): void => {
    historyRows.clear();
    historyList.replaceChildren();
    historyStatus.textContent = historyStatusText(view);
    type HistoryCard = { readonly created_at: string; readonly entry: ResearchRunHistoryEntry } | { readonly created_at: string; readonly draft: ResearchRunSavedDraft };
    const drafts = view.saved_drafts.filter((draft) => !view.runs.some((entry) => entry.status.answer.availability === "draft" && sameArtifact(entry.status.answer.artifact_ref, draft.artifact_ref)));
    const cards: HistoryCard[] = [
      ...view.runs.map((entry): HistoryCard => ({ created_at: entry.created_at, entry })),
      ...drafts.map((draft): HistoryCard => ({ created_at: draft.created_at, draft })),
    ].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    cards.forEach((card) => historyList.append("entry" in card ? renderHistory(card.entry) : renderSavedDraft(card.draft, view.deployment_generation)));
  };
  const updateHistoryStatus = (view: ResearchRunStatusView): void => {
    if (historyView === undefined || historyView.deployment_generation !== view.deployment_generation) return;
    const index = historyView.runs.findIndex((entry) => entry.status.workflow_instance_id === view.workflow_instance_id && entry.status.deployment_generation === view.deployment_generation);
    if (index < 0) return;
    const updatedHistoryView = { ...historyView, runs: historyView.runs.map((entry, entryIndex) => entryIndex === index ? { ...entry, status: view } : entry) };
    historyView = updatedHistoryView;
    const draftAnswer = view.answer.availability === "draft" ? view.answer : undefined;
    if (draftAnswer !== undefined && updatedHistoryView.saved_drafts.some((draft) => sameArtifact(draft.artifact_ref, draftAnswer.artifact_ref))) {
      renderHistoryList(updatedHistoryView);
      return;
    }
    const row = historyRows.get(view.workflow_instance_id);
    const note = row?.querySelector<HTMLElement>(".workflow-recovery-note");
    if (note !== null && note !== undefined) note.textContent = historyNoteText(view);
    historyStatus.textContent = historyStatusText(updatedHistoryView);
  };
  const loadHistory = (trigger: "automatic" | "manual" = "manual", force = false): void => {
    if (disposed) return;
    const generation = deploymentGeneration();
    if (!healthReady() || !navigator.onLine || generation === undefined || document.visibilityState === "hidden") {
      if (trigger === "manual") historyStatus.textContent = "Reconnect before loading saved research.";
      return;
    }
    if (historyController !== undefined) { if (!force) return; clearHistoryRequest(); }
    if (!force && trigger === "automatic" && historyGeneration === generation) return;
    const active = ++historySerial; const local = new AbortController(); historyController = local; historyGeneration = generation;
    historyRefresh.disabled = true;
    if (trigger === "manual" || historyList.childElementCount === 0) historyStatus.textContent = "Loading saved research…";
    void readResearchRunHistory(generation, local.signal)
      .then((view) => { if (active !== historySerial || disposed) return; historyGeneration = view.deployment_generation; historyView = view; renderHistoryList(view); })
      .catch((error: unknown) => {
        if (active !== historySerial || (error instanceof Error && error.name === "AbortError")) return;
        if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) { clearPrivate(); return; }
        if (error instanceof ApiRequestError && error.status === 403) {
          historyView = undefined;
          historyRows.clear();
          historyList.replaceChildren();
        }
        historyGeneration = undefined;
        if (historyView !== undefined) renderHistoryList(historyView);
        historyStatus.textContent = historyErrorMessage(error);
      })
      .finally(() => { if (active === historySerial) { historyController = undefined; updateButtons(); } });
  };
  type ReportRenderOptions = { readonly renderSerial: number; readonly deploymentGeneration: string; readonly historical: boolean; readonly workflowInstanceId?: string; readonly investigationRef?: string; readonly authorizationScopeSnapshotRef?: { readonly id: string; readonly revision: number } };
  const renderArtifactReport = (artifact: ArtifactRevision, options: ReportRenderOptions): void => {
    const reportHead = document.createElement("div"); reportHead.className = "research-report-heading";
    const reportTitle = document.createElement("h3"); reportTitle.textContent = options.historical ? "Saved research draft" : "Research draft";
    const draftBadge = document.createElement("span"); draftBadge.className = "research-draft-badge"; draftBadge.textContent = "DRAFT";
    reportHead.append(reportTitle, draftBadge);
    const technical = document.createElement("details"); technical.className = "research-technical-details";
    const technicalSummary = document.createElement("summary"); technicalSummary.textContent = "Technical details";
    const technicalFields = document.createElement("dl"); technicalFields.className = "research-technical-fields";
    const technicalField = (label: string, value: string): void => {
      const term = document.createElement("dt"); term.textContent = label;
      const detail = document.createElement("dd"); detail.append(codeRef(value));
      technicalFields.append(term, detail);
    };
    if (options.workflowInstanceId !== undefined) technicalField("Run ID", options.workflowInstanceId);
    if (options.investigationRef !== undefined) technicalField("Investigation", options.investigationRef);
    technicalField("Artifact", `${artifact.artifact_ref.id}:${artifact.artifact_ref.revision}`);
    technicalField("Specification", `${artifact.spec_ref.id}:${artifact.spec_ref.revision}`);
    technicalField("Evidence freeze", `${artifact.evidence_freeze_ref.id}:${artifact.evidence_freeze_ref.revision}`);
    if (options.authorizationScopeSnapshotRef !== undefined) technicalField("Authorized scope", `${options.authorizationScopeSnapshotRef.id}:${options.authorizationScopeSnapshotRef.revision}`);
    technicalField("Status", artifact.status);
    technical.append(technicalSummary, technicalFields);
    const reportActions = document.createElement("div"); reportActions.className = "research-report-actions";
    const download = document.createElement("button"); download.type = "button"; download.className = "button button--quiet"; download.textContent = "Download Markdown";
    if (artifact.sections.length === 0) {
      download.disabled = true; download.dataset.reportActionUnavailable = "true";
      const empty = document.createElement("p"); empty.className = "research-download-status"; empty.textContent = "This draft has no report sections to download."; reportActions.append(empty);
    }
    download.onclick = () => {
      if (options.renderSerial !== serial || controller !== undefined) return;
      const local = new AbortController(); controller = local; setReportActionsDisabled(true); status.textContent = "Preparing Markdown download…";
      void (async () => {
        const sections: ResearchMarkdownSection[] = [];
        for (const section of artifact.sections) {
          if (options.renderSerial !== serial || deploymentGeneration() !== options.deploymentGeneration) return;
          const readback = await readReauthorizedResearchArtifactSection(artifact.artifact_ref, section.section_ref, options.deploymentGeneration, local.signal);
          if (readback.body_object_ref !== section.body_object_ref || readback.body_sha256 !== section.body_sha256) throw new ApiRequestError({ status: 502, code: "RESEARCH_ARTIFACT_SECTION_INVALID", message: "The report section changed during reauthorization" });
          const citations = await readReauthorizedResearchArtifactSectionCitations(artifact.artifact_ref, section.section_ref, options.deploymentGeneration, local.signal, section.verification_receipt_ref);
          if (citations.verification_receipt_ref !== section.verification_receipt_ref) throw new ApiRequestError({ status: 502, code: "RESEARCH_ARTIFACT_SECTION_INVALID", message: "The report verification receipt changed during reauthorization" });
          sections.push({
            sectionRef: citationRefKey(citations.section_ref),
            originalScopeSnapshotRef: citationRefKey(citations.original_scope_snapshot_ref),
            authorizationScopeSnapshotRef: citationRefKey(citations.authorization_scope_snapshot_ref),
            body: decodeSectionBody(readback.bytes),
            semanticVerification: citations.semantic_verification,
            verificationReceiptRef: citations.verification_receipt_ref,
            claims: citations.semantic_verification === "EXECUTED" ? citations.audit.claims.map((claim) => ({
              claimText: claim.claim_text,
              claimTextDigest: claim.claim_text_digest,
              verdict: AUDIT_DISPOSITION_LABELS[claim.disposition],
              supportRefs: claim.support_handle_refs.map(citationRefKey),
              counterevidenceRefs: claim.counterevidence_handle_refs.map(citationRefKey),
            })) : [],
            audit: citations.semantic_verification === "EXECUTED" ? {
              stageAttemptRef: citations.audit.stage_attempt_ref,
              stageRequestSha256: citations.audit.stage_request_sha256,
              outputSha256: citations.audit.output_sha256,
              synthesisOutputSha256: citations.audit.synthesis_output_sha256,
              normalizationBindingSha256: citations.audit.normalization_binding_sha256,
              verifierRef: citations.audit.verifier_ref,
              verifierSchemaGeneration: citations.audit.verifier_schema_generation,
              modelReceiptRef: citations.audit.model_receipt_ref,
            } : undefined,
            citations: citations.cited_evidence.map((citation) => ({
              originalHandleRef: citationRefKey(citation.original_handle_ref),
              handleRef: citationRefKey(citation.handle_ref),
              excerptSha256: citation.excerpt_sha256,
            })),
          });
        }
        if (options.renderSerial !== serial || deploymentGeneration() !== options.deploymentGeneration) return;
        downloadResearchDraftMarkdown(citationRefKey(artifact.artifact_ref), artifact.created_at, sections);
        status.textContent = "Research draft downloaded as Markdown.";
      })()
        .catch((error: unknown) => {
          if (options.renderSerial !== serial || (error instanceof Error && error.name === "AbortError")) return;
          if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 409 || error.status === 410)) { clearPrivate(); return; }
          status.textContent = `Research draft could not be downloaded. ${message(error)}`;
        })
        .finally(() => finishReportAction(local, options.renderSerial));
    };
    reportActions.append(download); result.append(reportHead, technical, reportActions);
    const sections = document.createElement("ul"); sections.className = "research-report-sections";
    artifact.sections.forEach((section, ordinal) => {
      const item = document.createElement("li"); item.className = "research-report-section";
      const sectionHeading = document.createElement("h4"); sectionHeading.textContent = `Section ${ordinal + 1}`;
      const sectionTechnical = document.createElement("details"); sectionTechnical.className = "research-section-details";
      const sectionTechnicalSummary = document.createElement("summary"); sectionTechnicalSummary.textContent = "Section details";
      const sectionTechnicalFields = document.createElement("dl"); sectionTechnicalFields.className = "research-technical-fields";
      const sectionField = (label: string, value: string): void => {
        const term = document.createElement("dt"); term.textContent = label;
        const detail = document.createElement("dd"); detail.append(codeRef(value));
        sectionTechnicalFields.append(term, detail);
      };
      sectionField("Section ref", `${section.section_ref.id}:${section.section_ref.revision}`);
      sectionField("Evidence ledger", section.evidence_ledger_ref);
      sectionField("Verification receipt", section.verification_receipt_ref);
      sectionTechnical.append(sectionTechnicalSummary, sectionTechnicalFields);
      const open = document.createElement("button"); open.type = "button"; open.className = "button button--quiet"; open.textContent = "Open section";
      open.onclick = () => {
        if (options.renderSerial !== serial || controller !== undefined) return;
        const local = new AbortController(); controller = local; setReportActionsDisabled(true); status.textContent = "Reading report section…";
        const read = readReauthorizedResearchArtifactSection(artifact.artifact_ref, section.section_ref, options.deploymentGeneration, local.signal);
        void read
          .then((readback) => {
            if (options.renderSerial !== serial || deploymentGeneration() !== options.deploymentGeneration) return;
            if (readback.body_object_ref !== section.body_object_ref || readback.body_sha256 !== section.body_sha256) throw new ApiRequestError({ status: 502, code: "RESEARCH_ARTIFACT_SECTION_INVALID", message: "The report section changed during reauthorization" });
            const body = document.createElement("pre"); body.className = "research-section-body"; body.textContent = decodeSectionBody(readback.bytes);
            item.querySelector(".research-section-body")?.remove(); item.append(body); status.textContent = "Report section opened.";
          })
          .catch((error: unknown) => {
            if (options.renderSerial !== serial || (error instanceof Error && error.name === "AbortError")) return;
            if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 409 || error.status === 410)) { clearPrivate(); return; }
            if (error instanceof ApiRequestError && error.status === 403) item.querySelector(".research-section-body")?.remove();
            const failure = document.createElement("p"); failure.className = "research-section-error"; failure.textContent = message(error); item.querySelector(".research-section-error")?.remove(); item.append(failure);
            status.textContent = "The report section could not be opened.";
          })
          .finally(() => finishReportAction(local, options.renderSerial));
      };
      const sources = document.createElement("button"); sources.type = "button"; sources.className = "button button--quiet"; sources.textContent = "Open sources"; sources.dataset.openSources = String(ordinal);
      sources.onclick = () => {
        if (options.renderSerial !== serial || controller !== undefined) return;
        const local = new AbortController(); controller = local; setReportActionsDisabled(true); status.textContent = "Reading cited sources…";
        item.querySelector(".research-citations")?.remove(); item.querySelector(".research-citation-error")?.remove();
        const read = readReauthorizedResearchArtifactSectionCitations(artifact.artifact_ref, section.section_ref, options.deploymentGeneration, local.signal, section.verification_receipt_ref);
        void read
          .then((citations) => {
            if (options.renderSerial !== serial) return;
            const list = document.createElement("div"); list.className = "research-citations";
            const state = document.createElement("p"); state.className = "research-citation-state";
            state.textContent = citations.semantic_verification === "EXECUTED"
              ? auditStatusText(citations.audit.claims)
              : options.historical ? "Saved citations were reauthorized for this session; no claim check is recorded." : "Draft claims have not been checked. Opening a source checks its current bytes.";
            list.append(state); const aliases = citations.cited_evidence;
            const citationByRef = new Map(aliases.map((citation) => [citationRefKey(citation.original_handle_ref), citation]));
            const citationScope = citations.authorization_scope_snapshot_ref;
            const selectCitation = (citation: typeof aliases[number]): void => {
              if (options.renderSerial !== serial || controller !== undefined) return;
              element.dispatchEvent(new CustomEvent("research:evidence-selected", { bubbles: true, detail: { scopeSnapshotRef: citationScope, handleRef: citation.handle_ref, excerptSha256: citation.excerpt_sha256 } }));
              status.textContent = "Source selected. Verify it in the Evidence rail.";
            };
            const appendClaimEvidenceButton = (container: HTMLElement, kind: "Support" | "Counterevidence", ref: ResearchArtifactSectionCitationAuditClaim["support_handle_refs"][number], ordinal: number): void => {
              const citation = citationByRef.get(citationRefKey(ref));
              const button = document.createElement("button"); button.type = "button"; button.className = "button button--quiet";
              button.textContent = citation === undefined ? `${kind} evidence unavailable` : `${kind} evidence ${ordinal + 1}`;
              if (citation === undefined) { button.disabled = true; button.dataset.reportActionUnavailable = "true"; }
              else button.onclick = () => selectCitation(citation);
              container.append(button);
            };
            if (citations.semantic_verification === "EXECUTED") {
              const auditDetails = document.createElement("details"); auditDetails.className = "research-audit-details";
              const auditSummary = document.createElement("summary"); auditSummary.textContent = "Claim check details";
              const claimList = document.createElement("ol"); claimList.className = "research-audit-claims";
              citations.audit.claims.forEach((claim) => {
                const claimItem = document.createElement("li");
                const claimText = document.createElement("p"); claimText.textContent = claim.claim_text;
                const verdict = document.createElement("p"); verdict.textContent = `Verdict: ${AUDIT_DISPOSITION_LABELS[claim.disposition]}`;
                claimItem.append(claimText, verdict);
                const claimActions = document.createElement("div"); claimActions.className = "research-citation-actions";
                claim.support_handle_refs.forEach((ref, index) => appendClaimEvidenceButton(claimActions, "Support", ref, index));
                claim.counterevidence_handle_refs.forEach((ref, index) => appendClaimEvidenceButton(claimActions, "Counterevidence", ref, index));
                if (claimActions.childElementCount > 0) claimItem.append(claimActions);
                claimList.append(claimItem);
              });
              auditDetails.append(auditSummary, claimList); list.append(auditDetails);
            }
            if (citations.cited_evidence.length === 0) { const empty = document.createElement("p"); empty.textContent = "No cited source handles are available."; list.append(empty); } else {
              const heading = document.createElement("p"); heading.textContent = "Open a cited source in the Evidence rail:"; list.append(heading);
              const actions = document.createElement("div"); actions.className = "research-citation-actions";
              aliases.forEach((citation, citationOrdinal) => {
                const button = document.createElement("button"); button.type = "button"; button.className = "button button--quiet"; button.textContent = `Open source ${citationOrdinal + 1}`; button.dataset.openCitation = String(citationOrdinal); button.disabled = controller !== undefined;
                button.onclick = () => selectCitation(citation);
                actions.append(button);
              });
              list.append(actions);
            }
            item.append(list); status.textContent = citations.semantic_verification === "EXECUTED"
              ? "Claim check loaded. Review each verdict and its evidence."
              : "Cited sources loaded; fresh verification is still required.";
          })
          .catch((error: unknown) => {
            if (options.renderSerial !== serial || (error instanceof Error && error.name === "AbortError")) return;
            if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 409 || error.status === 410)) { clearPrivate(); return; }
            if (error instanceof ApiRequestError && error.status === 403) item.querySelector(".research-citations")?.remove();
            const failure = document.createElement("p"); failure.className = "research-citation-error"; failure.textContent = message(error); item.querySelector(".research-citation-error")?.remove(); item.append(failure);
            status.textContent = "Cited sources could not be read.";
          })
          .finally(() => finishReportAction(local, options.renderSerial));
      };
      const actions = document.createElement("div"); actions.className = "research-report-actions"; actions.append(open, sources);
      item.append(sectionHeading, sectionTechnical, actions); sections.append(item);
    });
    result.append(sections);
  };
  const readSavedDraft = (draft: ResearchRunSavedDraft): void => {
    const generation = deploymentGeneration();
    if (disposed || !healthReady() || !navigator.onLine || generation === undefined) { status.textContent = "Owner workspace is unavailable. Reconnect before opening saved research."; return; }
    clearProgressTimer();
    const active = ++serial; controller?.abort(); const local = new AbortController(); controller = local;
    workflowId = undefined; workflowGeneration = undefined; workflowInput.value = "";
    lastExecutionState = undefined; lastEngineStatus = undefined; lastAnswerAvailability = undefined;
    result.replaceChildren(); result.hidden = true; badge.textContent = "WAITING"; progress.textContent = "Opening saved research…"; status.textContent = "Opening saved research…"; updateButtons();
    void readReauthorizedResearchArtifact(draft.artifact_ref, generation, local.signal)
      .then((reauthorized) => {
        if (active !== serial || disposed) return;
        lastExecutionState = "ENGINE_COMPLETED"; lastEngineStatus = "complete"; lastAnswerAvailability = "draft";
        badge.textContent = "DRAFT"; progress.textContent = "Saved draft opened for review."; result.replaceChildren();
        renderArtifactReport(reauthorized.artifact, { renderSerial: active, deploymentGeneration: reauthorized.deployment_generation, historical: true, authorizationScopeSnapshotRef: reauthorized.authorization_scope_snapshot_ref });
        result.hidden = false; status.textContent = "Saved draft opened. Open a section to recheck its sources."; setReportActionsDisabled(true);
      })
      .catch((error: unknown) => {
        if (active !== serial || (error instanceof Error && error.name === "AbortError")) return;
        if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) { clearPrivate(); return; }
        lastExecutionState = undefined; lastEngineStatus = undefined; lastAnswerAvailability = undefined; result.replaceChildren(); result.hidden = true;
        badge.textContent = idleBadgeText(healthReady() && researchConfigurationReady()); progress.textContent = "Saved draft could not be opened."; status.textContent = message(error);
      })
      .finally(() => { if (active === serial) { controller = undefined; if (!disposed) setReportActionsDisabled(false); updateButtons(); } });
  };
  const renderStatus = (view: ResearchRunStatusView, artifact?: ArtifactRevision, renderSerial = serial): void => {
    lastExecutionState = view.execution_state;
    lastEngineStatus = view.engine_status;
    lastAnswerAvailability = view.answer.availability;
    updateHistoryStatus(view);
    const text = statusText(view);
    badge.textContent = badgeText(view);
    progress.textContent = text;
    result.replaceChildren();
    const heading = document.createElement("p"); const strong = document.createElement("strong"); strong.textContent = text; heading.append(strong);
    const identity = document.createElement("p"); identity.append("Run ID ", codeRef(view.workflow_instance_id), " · investigation ", codeRef(view.investigation_ref.id));
    result.append(heading);
    if (view.answer.availability === "draft" && artifact !== undefined) {
      renderArtifactReport(artifact, { renderSerial, deploymentGeneration: view.deployment_generation, historical: false, workflowInstanceId: view.workflow_instance_id, investigationRef: `${view.investigation_ref.id}:${view.investigation_ref.revision}` });
    } else {
      result.append(identity);
    }
    result.hidden = false;
    setReportActionsDisabled(controller !== undefined);
    if (status.textContent !== text) status.textContent = text;
    refresh.disabled = false;
    if (view.execution_state === "ACTIVE" && shouldPollEngine(view.engine_status)) scheduleStatusRefresh(); else clearProgressTimer();
  };
  const readStatus = (trigger: "manual" | "automatic" | "history" = "manual", requestedWorkflowId?: string): void => {
    if (trigger === "automatic" && (lastExecutionState !== "ACTIVE" || controller !== undefined || !shouldPollEngine(lastEngineStatus))) {
      scheduleStatusRefresh();
      return;
    }
    const automatic = trigger === "automatic";
    const requestedId = requestedWorkflowId ?? (automatic ? workflowId : workflowInput.value.trim());
    if (requestedId === undefined || requestedId.length === 0) {
      if (!automatic) status.textContent = "Enter a known Run ID first.";
      return;
    }
    const id = requestedId;
    if (!healthReady() || !navigator.onLine || deploymentGeneration() === undefined) { status.textContent = "Owner workspace is unavailable. Reconnect before reading research."; return; }
    clearProgressTimer();
    const active = ++serial; controller?.abort(); const local = new AbortController(); controller = local;
    if (!automatic) {
      result.replaceChildren(); result.hidden = true; submit.disabled = true; recover.disabled = true; refresh.disabled = true; status.textContent = "Reading research status…";
    }
    const expectedGeneration = id === workflowId ? (workflowGeneration ?? deploymentGeneration()) : deploymentGeneration();
    const canRetryAuthority = (error: unknown): boolean => shouldRetryResearchAuthority(error, { automatic, requestedId: id, workflowId, expectedGeneration, isCurrent: () => active === serial, currentGeneration: deploymentGeneration, healthReady, online: () => navigator.onLine, visible: () => document.visibilityState !== "hidden" });
    void readResearchStatusWithAuthorityRetry(() => readResearchRunStatus(id, expectedGeneration, local.signal), canRetryAuthority, () => { status.textContent = "Refreshing research status…"; })
      .then(async (view) => {
        if (active !== serial) return;
        const artifact = view.answer.availability === "draft" ? await readResearchArtifact(view.answer.artifact_ref, view.deployment_generation, local.signal) : undefined;
        if (active !== serial) return;
        workflowId = view.workflow_instance_id; workflowGeneration = view.deployment_generation;
        if (trigger !== "history" && (!automatic || workflowInput.value.trim() === id)) workflowInput.value = view.workflow_instance_id;
        renderStatus(view, artifact);
      })
      .catch((error: unknown) => {
        if (active !== serial || (error instanceof Error && error.name === "AbortError")) return;
        lastExecutionState = undefined; lastEngineStatus = undefined; clearProgressTimer();
        const statusReadbackFailure = error instanceof ApiRequestError && error.status === 409 && error.code === "RESEARCH_RUN_STATUS_INVALID";
        if (statusReadbackFailure) {
          const notice = "Research status could not be read consistently. The run is still loaded; use Refresh status to try again.";
          progress.textContent = notice;
          status.textContent = notice;
          console.warn("research_run_read_failed", JSON.stringify({ code: error.code, status: error.status }));
          return;
        }
        const privateFailure = error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED");
        if (!automatic || privateFailure) { result.replaceChildren(); result.hidden = true; }
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) {
          if (error.status === 409 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED") showUnavailableRun(error); else status.textContent = message(error);
        } else status.textContent = message(error);
      })
      .finally(() => finishResearchStatusRead(active === serial, () => { controller = undefined; }, disposed, () => setReportActionsDisabled(false), updateButtons, scheduleStatusRefresh));
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const generation = deploymentGeneration();
    if (!healthReady() || !navigator.onLine || generation === undefined) { status.textContent = "Owner workspace is unavailable. Reconnect before starting research."; return; }
    if (!researchConfigurationReady()) { status.textContent = "Research configuration is not ready. Check the Research configuration card before starting a run."; return; }
    if (scope.value === "selected" && selectedSourceId === undefined) { status.textContent = "Select a source before starting research."; return; }
    const ids = scope.value === "selected" ? [selectedSourceId as string] : [];
    let body: string;
    try { body = researchRunBody(query.value, ids); } catch (error: unknown) { status.textContent = message(error); return; }
    clearProgressTimer(); lastExecutionState = undefined;
    const active = ++serial; controller?.abort(); const local = new AbortController(); controller = local;
    if (body !== previousBody) { previousBody = body; idempotencyKey = crypto.randomUUID(); }
    submit.disabled = true; refresh.disabled = true; recover.disabled = true; result.replaceChildren(); result.hidden = true; status.textContent = "Starting the research run…";
    element.dispatchEvent(new CustomEvent("research:started", { bubbles: true }));
    void startResearchRun(body, idempotencyKey, generation, local.signal)
      .then((view) => { if (active !== serial) return; workflowId = view.workflow_instance_id; workflowGeneration = view.deployment_generation; workflowInput.value = view.workflow_instance_id; lastExecutionState = "ACTIVE"; lastEngineStatus = undefined; lastAnswerAvailability = undefined; badge.textContent = "RUNNING"; progress.textContent = "Research started. Checking progress automatically."; refresh.disabled = false; status.textContent = "Research started. Checking progress automatically."; loadHistory("manual", true); })
      .catch((error: unknown) => { if (active !== serial || (error instanceof Error && error.name === "AbortError")) return; if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) clearPrivate(); else { badge.textContent = idleBadgeText(healthReady() && researchConfigurationReady()); progress.textContent = "Research could not be started."; status.textContent = message(error); } })
      .finally(() => { if (active === serial) { controller = undefined; updateButtons(); scheduleStatusRefresh(); } });
  };
  refresh.onclick = () => readStatus("manual", workflowId);
  recover.onclick = () => readStatus();
  historyRefresh.onclick = () => loadHistory("manual", true);
  const cleanup = (): void => {
    disposed = true;
    window.removeEventListener("eliotr:health-updated", onHealthUpdated);
    document.removeEventListener("visibilitychange", onVisibilityChanged);
    stop(); clearHistory();
  };
  if (healthReady()) loadHistory("automatic");
  return Object.assign(cleanup, {
    clearPrivate,
    refreshAvailability,
    selectSource(id: string, context?: LibrarySelectionContext): void {
      IdentifierSchema.parse(id); stop(); workflowId = undefined; workflowGeneration = undefined; previousBody = ""; idempotencyKey = ""; result.replaceChildren(); result.hidden = true;
      selectedSourceId = id; workflowInput.value = ""; updateButtons(); selectedOption.disabled = false; scope.value = "selected"; status.textContent = context?.sourceRevisionRef ? "Selected source ready for a research run." : "Selected source loaded; refresh the Library before starting.";
    },
  });
}
