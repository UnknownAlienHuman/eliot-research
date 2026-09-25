import { ResearchWorkflowStageSchema, type ResearchWorkflowStage, type ArtifactRevision } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import type { ResearchArtifactSectionCitationAuditClaim, ResearchEngineStatus, ResearchRunHistoryEntry, ResearchRunHistoryView, ResearchRunSavedDraft, ResearchRunStatusView, ResearchSourceFreshness } from "./research-run-api.js";

export const RESEARCH_STAGE_LABELS: Record<ResearchWorkflowStage, string> = {
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
export const RESEARCH_STAGE_ORDER = ResearchWorkflowStageSchema.options;
export const RESEARCH_STATUS_REFRESH_MS = 2_000;
export const AUDIT_DISPOSITION_LABELS: Record<ResearchArtifactSectionCitationAuditClaim["disposition"], string> = {
  SUPPORTED: "Supported",
  PARTIALLY_SUPPORTED: "Partially supported",
  UNSUPPORTED: "Unsupported",
  CONTRADICTED: "Contradicted",
  NOT_VERIFIABLE_IN_SCOPE: "Could not be verified in this scope",
};
export function message(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "RESEARCH_AGENT_NOT_CONFIGURED") return "Research agents are not configured on the server yet.";
    if (error.status === 401 || error.status === 403) return "This research run is no longer available for the current session.";
    if (error.status === 409) return "The Research run belongs to another deployment or its authority changed. Refresh the workspace.";
    if (error.retryable) return "The Research service is unavailable. Refresh to try again.";
    return "The Research run could not be read. Check the query and session.";
  }
  return "The Research run could not be read. Check the query and session.";
}
export function statusText(view: ResearchRunStatusView): string {
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
export function badgeText(view: ResearchRunStatusView): string {
  if (view.execution_state === "ACTIVE") {
    return view.engine_status === "errored" || view.engine_status === "terminated" ? "FAILED" : "RUNNING";
  }
  if (view.execution_state === "CANCELLED") return "CANCELLED";
  return view.answer.availability === "draft" ? "DRAFT" : "COMPLETE";
}
export function idleBadgeText(healthReady: boolean, configurationReady: boolean): string {
  if (!healthReady) return "WAITING";
  return configurationReady ? "READY" : "BLOCKED";
}
export function idleProgressText(healthReady: boolean, configurationReady: boolean): string {
  if (!healthReady) return "Waiting for the current owner session.";
  return configurationReady ? "Ready to start a research run." : "Research is unavailable. Open Connections to check the configuration before starting a run.";
}
export function wikiProposalErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) return "Wiki draft creation is unavailable for the current owner session.";
    if (error.code === "WIKI_DEPLOYMENT_CHANGED" || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED") return "The workspace changed while saving the Wiki draft. Refresh the workspace and try again.";
    if (error.retryable) return "Wiki draft creation is temporarily unavailable. Try again from this report.";
  }
  return "Wiki draft could not be saved. Try again from this report.";
}
function failureCauseText(failure: ResearchRunStatusView["failure"]): string | undefined {
  switch (failure?.code) {
    case "WORKFLOW_OUTPUT_CORRUPT":
      return "A produced or saved Research result failed integrity or format validation. This run has no verified answer. Your saved reports are still available.";
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
    case "WORKFLOW_CONFIGURATION_MISSING":
      return "Required Research configuration is missing. Configure the server before recovering this run.";
    case "WORKFLOW_CONFIGURATION_INVALID":
      return "Research configuration is invalid. Correct it before recovering this run.";
    case "WORKFLOW_CREDENTIALS_MISSING":
      return "Research gateway credentials or the native binding are missing.";
    case "WORKFLOW_CREDENTIALS_INVALID":
    case "MODEL_GATEWAY_CREDENTIAL_INVALID":
    case "MODEL_GATEWAY_AUTH_REJECTED":
      return "The Research gateway credentials are invalid or were rejected.";
    case "WORKFLOW_STORAGE_UNAVAILABLE":
      return "Research preparation could not read its required storage. This is not proof that access was revoked.";
    case "WORKFLOW_QUALIFICATION_STALE":
      return "The configured model route qualification is unavailable, expired or changed.";
    case "WORKFLOW_PREPARATION_FAILED":
      return "Research preparation failed before a safe specific cause could be identified.";
    case "MODEL_ATTEMPT_BUDGET_EXPIRED":
      return "The model attempt's original budget reservation expired.";
    case "MODEL_GATEWAY_RESPONSE_INVALID":
    case "MODEL_GATEWAY_OUTPUT_TRUNCATED":
    case "MODEL_ATTEMPT_READBACK_CORRUPT":
      return "The model result was incomplete or failed validation. It was not accepted as a verified answer.";
    default:
      return failure === undefined ? undefined : `Research stopped with code ${failure.code}.`;
  }
}
export function failureText(failure: ResearchRunStatusView["failure"]): string | undefined {
  const initial = failureCauseText(failure);
  if (failure === undefined || initial === undefined) return initial;
  const location = failure.phase === "PREPARATION" ? "During preparation. "
    : failure.stage === undefined ? "" : `At ${failure.stage.replaceAll("_", " ")}. `;
  const subsequent = failure.consequence === undefined ? ""
    : ` Later failure (${failure.consequence.code}): ${failureCauseText(failure.consequence)}`;
  return `${location}${initial}${subsequent}`;
}

export function auditStatusText(claims: readonly ResearchArtifactSectionCitationAuditClaim[]): string {
  if (claims.some((claim) => claim.disposition === "NOT_VERIFIABLE_IN_SCOPE")) {
    return `${claims.length} claim assessments are recorded. Some claims could not be verified. Review the draft and its sources.`;
  }
  return `${claims.length} claim assessments are recorded. The verdicts describe the saved evidence; they do not mean every claim is true.`;
}
export function historyStageText(view: ResearchRunStatusView): string {
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
export function historyNoteText(view: ResearchRunStatusView): string {
  const stage = historyStageText(view);
  if (view.execution_state === "ENGINE_COMPLETED" && view.answer.availability === "draft") return stage;
  return `${stage} · ${view.answer.availability === "draft" ? "Draft available" : "No draft available"}`;
}
export function historyStatusText(view: ResearchRunHistoryView): string {
  if (view.configuration_state === "MISSING") return "Research configuration is missing on the server. Install it before starting a research run.";
  if (view.runs.length === 0 && view.saved_drafts.length === 0) return "Configuration installed; run research to confirm execution. No saved runs are available yet.";
  const hasSavedDraft = view.saved_drafts.length > 0 || view.runs.some((entry) => entry.status.execution_state === "ENGINE_COMPLETED" && entry.status.answer.availability === "draft");
  return hasSavedDraft ? "Configuration installed; a saved draft is available below." : "Configuration installed; recent runs below show actual execution.";
}
export function shouldPollEngine(status: ResearchEngineStatus | undefined): boolean {
  return status === undefined || status === "queued" || status === "running" || status === "paused" || status === "waiting" || status === "waitingForPause";
}
export function historyDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
export function historyErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) return "Saved research is no longer available for this session.";
    if (error.retryable) return "Saved research is temporarily unavailable. Refresh to try again.";
  }
  return "Saved research could not be loaded. Refresh to try again.";
}
export function decodeSectionBody(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new ApiRequestError({ status: 502, code: "RESEARCH_ARTIFACT_SECTION_INVALID", message: "The report section is not valid UTF-8" }); }
}
export function codeRef(value: string): HTMLElement {
  const code = document.createElement("code");
  code.textContent = value;
  return code;
}
export function citationRefKey(ref: { readonly id: string; readonly revision: number }): string {
  return `${ref.id}:${ref.revision}`;
}
export function sameArtifact(left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean {
  return left.id === right.id && left.revision === right.revision;
}
export function renderResearchSourceFreshnessNotice(freshness: ResearchSourceFreshness): HTMLElement | undefined {
  if (freshness.state === "UNKNOWN") return undefined;
  const notice = document.createElement("p"); notice.className = "research-source-freshness";
  notice.textContent = freshness.state === "PREVIOUS_REVISIONS"
    ? "Source updated — this report uses an earlier source revision. Its saved text and citations remain available; review it against the updated document."
    : "Source revisions matched when this saved report was reopened.";
  return notice;
}
export function appendResearchSourceFreshnessDetails(fields: HTMLElement, freshness: ResearchSourceFreshness): void {
  if (freshness.state === "UNKNOWN") return;
  const add = (label: string, value: string): void => {
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.append(codeRef(value)); fields.append(term, detail);
  };
  add("Source freshness", freshness.state);
  add("Freshness checked", freshness.checked_at ?? "not recorded");
  add("Changed sources", freshness.changed_sources.length === 0
    ? "None recorded"
    : freshness.changed_sources.map((source) => `${source.source_id}: saved ${source.saved_revision_ref}; current ${source.head_revision_ref}`).join(" · "));
}
export function currentResearchRunBadge(state: ResearchRunStatusView["execution_state"] | undefined,
  engine: ResearchEngineStatus | undefined, answer: ResearchRunStatusView["answer"]["availability"] | undefined,
  healthReady: boolean, configurationReady: boolean): string {
  if (state === undefined) return idleBadgeText(healthReady, configurationReady);
  if (state === "ACTIVE") return engine === "errored" || engine === "terminated" ? "FAILED" : "RUNNING";
  if (state === "CANCELLED") return "CANCELLED";
  return answer === "draft" ? "DRAFT" : "COMPLETE";
}

export function createResearchRunView(element: HTMLElement, healthReady: boolean, configurationReady: boolean) {
  element.innerHTML = `<div class="workflow-head"><div><span class="eyebrow">Research</span><h2>Ask a question</h2></div><span class="workflow-badge" data-run-badge>${idleBadgeText(healthReady, configurationReady)}</span></div>
    <p class="workflow-status workflow-progress-summary" data-run-progress aria-live="polite">${idleProgressText(healthReady, configurationReady)}</p>
    <form class="research-question-form"><label>Question<textarea name="query" rows="4" autocomplete="off" required placeholder="What would you like to learn from your sources?" class="research-question-input"></textarea></label>
    <div class="research-question-controls"><label>Scope<select name="scope"><option value="library">Entire authorized Library</option><option value="project" disabled>Selected project</option><option value="selected" disabled>Selected source</option></select></label>
    <div class="workflow-actions"><button type="submit" class="button">Start research</button><button type="button" class="button button--quiet" data-run-refresh disabled>Refresh status</button></div></div></form>
    <button class="research-configuration-link workspace-jump" type="button" data-nav-target="#research-configuration-card" aria-controls="research-configuration-card">Connections and research configuration</button>
    <p class="workflow-status" role="status" aria-live="polite">${idleProgressText(healthReady, configurationReady)}</p>
    <div class="workflow-actions" role="group" aria-label="Manage the loaded research run"><button type="button" class="button button--quiet" data-run-cancel disabled>Stop research</button><button type="button" class="button button--quiet" data-run-resume disabled>Recover research</button></div>
    <section data-run-result hidden></section>
    <details class="workflow-recovery research-history" data-research-history><summary>Recent research</summary><div class="workflow-recovery-head"><h3 id="research-history-title">Saved runs and drafts</h3><button type="button" class="button button--quiet" data-research-history-refresh disabled>Refresh</button></div>
      <p class="workflow-recovery-status" data-research-history-status>Recent research appears after the current session is ready.</p><div class="workflow-recovery-list" data-research-history-list></div></details>
    <details class="workflow-recovery research-recovery" data-run-recovery><summary>Open a known run</summary><label>Run ID<input data-workflow-id maxlength="128" autocomplete="off" placeholder="Paste a known run ID"></label><button type="button" class="button button--quiet" data-recover>Load status</button></details>`;
  const form = element.querySelector<HTMLFormElement>("form");
  const badge = element.querySelector<HTMLElement>("[data-run-badge]");
  const progress = element.querySelector<HTMLElement>("[data-run-progress]");
  const query = element.querySelector<HTMLTextAreaElement>('textarea[name="query"]');
  const scope = element.querySelector<HTMLSelectElement>('select[name="scope"]');
  const projectOption = scope?.querySelector<HTMLOptionElement>('option[value="project"]');
  const selectedOption = scope?.querySelector<HTMLOptionElement>('option[value="selected"]');
  const submit = element.querySelector<HTMLButtonElement>('button[type="submit"]'); const refresh = element.querySelector<HTMLButtonElement>("[data-run-refresh]");
  const workflowInput = element.querySelector<HTMLInputElement>("[data-workflow-id]"); const recover = element.querySelector<HTMLButtonElement>("[data-recover]");
  const status = element.querySelector<HTMLElement>('[role="status"]'); const result = element.querySelector<HTMLElement>("[data-run-result]");
  const historyRefresh = element.querySelector<HTMLButtonElement>("[data-research-history-refresh]"); const historyStatus = element.querySelector<HTMLElement>("[data-research-history-status]");
  const historyList = element.querySelector<HTMLElement>("[data-research-history-list]");
  if (!form || !badge || !progress || !query || !scope || !projectOption || !selectedOption || !submit || !refresh || !workflowInput || !recover || !status || !result || !historyRefresh || !historyStatus || !historyList) throw new Error("Research run panel is incomplete");
  return { form, badge, progress, query, scope, projectOption, selectedOption, submit, refresh, workflowInput, recover, status, result, historyRefresh, historyStatus, historyList };
}

/** Presentation only: callers retain session, generation and connected-node guards. */
export function createResearchHistoryRow(createdAt: string, noteText: string, savedDraft: boolean): { row: HTMLDivElement; open: HTMLButtonElement } {
  const row = document.createElement("div"); row.className = "workflow-recovery-row";
  const open = document.createElement("button"); open.type = "button"; open.className = "workflow-recovery-item";
  const date = historyDate(createdAt);
  open.textContent = `${savedDraft ? "Open saved research" : "Open research"} · ${date}`;
  open.setAttribute("aria-label", `${savedDraft ? "Open saved research draft" : "Open saved research"} from ${date}`);
  const note = document.createElement("p"); note.className = "workflow-recovery-note"; note.textContent = noteText;
  row.append(open, note);
  return { row, open };
}

type HistoryCard = { readonly created_at: string; readonly entry: ResearchRunHistoryEntry } | { readonly created_at: string; readonly draft: ResearchRunSavedDraft };
export function researchHistoryCards(view: ResearchRunHistoryView): HistoryCard[] {
  const drafts = view.saved_drafts.filter((draft) => !view.runs.some((entry) => entry.status.answer.availability === "draft" && sameArtifact(entry.status.answer.artifact_ref, draft.artifact_ref)));
  return [
    ...view.runs.map((entry): HistoryCard => ({ created_at: entry.created_at, entry })),
    ...drafts.map((draft): HistoryCard => ({ created_at: draft.created_at, draft })),
  ].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

export function renderResearchHistoryList(list: HTMLElement, status: HTMLElement, view: ResearchRunHistoryView,
  render: (card: HistoryCard) => HTMLElement): void {
  list.replaceChildren();
  status.textContent = historyStatusText(view);
  researchHistoryCards(view).forEach((card) => list.append(render(card)));
}

export function renderResearchStatusHeading(result: HTMLElement, view: ResearchRunStatusView): HTMLParagraphElement {
  result.replaceChildren();
  const heading = document.createElement("p"); const strong = document.createElement("strong"); strong.textContent = statusText(view); heading.append(strong);
  const identity = document.createElement("p"); identity.append("Run ID ", codeRef(view.workflow_instance_id), " · investigation ", codeRef(view.investigation_ref.id));
  result.append(heading);
  return identity;
}

interface ResearchReportHeaderOptions {
  readonly historical: boolean;
  readonly workflowInstanceId?: string;
  readonly investigationRef?: string;
  readonly authorizationScopeSnapshotRef?: { readonly id: string; readonly revision: number };
  readonly sourceFreshness?: ResearchSourceFreshness;
}
export function createResearchReportHeader(artifact: ArtifactRevision, options: ResearchReportHeaderOptions) {
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
  if (options.sourceFreshness !== undefined) appendResearchSourceFreshnessDetails(technicalFields, options.sourceFreshness);
  technical.append(technicalSummary, technicalFields);
  return { reportHead, technical };
}
