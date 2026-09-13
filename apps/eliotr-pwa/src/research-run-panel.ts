import { IdentifierSchema, ResearchWorkflowStageSchema, type ResearchWorkflowStage } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { readResearchRunHistory, researchRunBody, readResearchArtifact, readResearchArtifactSection, readResearchArtifactSectionCitations, readResearchRunStatus, startResearchRun, type ResearchRunHistoryEntry, type ResearchRunStatusView } from "./research-run-api.js";
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
      return `Research is processing. Current stage: ${label}. Status refreshes automatically.`;
    }
    case "CANCELLED": return "Research was cancelled. Answer unavailable.";
    case "ENGINE_COMPLETED": return view.answer.availability === "draft" ? "A draft report is ready for review." : "Processing finished. No answer has been generated.";
  }
}

function historyStageText(view: ResearchRunStatusView): string {
  if (view.execution_state === "ACTIVE") {
    const stage = RESEARCH_STAGE_ORDER[view.next_stage_index];
    return stage === undefined ? "Continuing through the research workflow" : RESEARCH_STAGE_LABELS[stage];
  }
  if (view.execution_state === "CANCELLED") return "Cancelled";
  return view.answer.availability === "draft" ? "Draft available" : "Finished without a report";
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

export function mountResearchRunPanel(
  element: HTMLElement,
  deploymentGeneration: () => string | undefined,
  healthReady: () => boolean = () => false,
): (() => void) & { clearPrivate(): void; selectSource(id: string, context?: LibrarySelectionContext): void } {
  element.innerHTML = `<div class="workflow-head"><div><span class="eyebrow">Research run</span><h2>Prepare a research run</h2></div><span class="workflow-badge" data-run-badge>${healthReady() ? "READY" : "WAITING"}</span></div>
    <p class="workflow-copy">Start research and open a saved draft when one is available.</p>
    <form><label>Question<input name="query" maxlength="4096" autocomplete="off" required placeholder="Ask a research question"></label>
    <label>Scope<select name="scope"><option value="library">Entire authorized Library</option><option value="selected" disabled>Selected source</option></select></label>
    <div class="workflow-actions"><button type="submit" class="button">Start research</button><button type="button" class="button button--quiet" data-run-refresh disabled>Refresh status</button></div></form>
    <section class="workflow-recovery" aria-labelledby="research-history-title"><div class="workflow-recovery-head"><div><span class="eyebrow">Saved research</span><h3 id="research-history-title">Recent research</h3></div><button type="button" class="button button--quiet" data-research-history-refresh disabled>Refresh</button></div>
      <p class="workflow-recovery-status" data-research-history-status>Recent research appears after the current session is ready.</p><div class="workflow-recovery-list" data-research-history-list></div></section>
    <div class="workflow-recovery"><label>Run ID<input data-workflow-id maxlength="128" autocomplete="off" placeholder="Paste a known run ID"></label><button type="button" class="button button--quiet" data-recover>Load status</button></div>
    <p class="workflow-status" role="status" aria-live="polite">${healthReady() ? "Ready when the current owner session is available." : "Waiting for the current owner session."}</p>
    <section data-run-result hidden></section>`;
  const form = element.querySelector<HTMLFormElement>("form");
  const badge = element.querySelector<HTMLElement>("[data-run-badge]");
  const query = element.querySelector<HTMLInputElement>('input[name="query"]');
  const scope = element.querySelector<HTMLSelectElement>('select[name="scope"]');
  const selectedOption = scope?.querySelector<HTMLOptionElement>('option[value="selected"]');
  const submit = element.querySelector<HTMLButtonElement>('button[type="submit"]');
  const refresh = element.querySelector<HTMLButtonElement>("[data-run-refresh]");
  const workflowInput = element.querySelector<HTMLInputElement>("[data-workflow-id]");
  const recover = element.querySelector<HTMLButtonElement>("[data-recover]");
  const status = element.querySelector<HTMLElement>('[role="status"]');
  const result = element.querySelector<HTMLElement>("[data-run-result]");
  const historyRefresh = element.querySelector<HTMLButtonElement>("[data-research-history-refresh]");
  const historyStatus = element.querySelector<HTMLElement>("[data-research-history-status]");
  const historyList = element.querySelector<HTMLElement>("[data-research-history-list]");
  if (!form || !badge || !query || !scope || !selectedOption || !submit || !refresh || !workflowInput || !recover || !status || !result || !historyRefresh || !historyStatus || !historyList) throw new Error("Research run panel is incomplete");

  let serial = 0;
  let controller: AbortController | undefined;
  let workflowId: string | undefined;
  let workflowGeneration: string | undefined;
  let selectedSourceId: string | undefined;
  let previousBody = "";
  let idempotencyKey = "";
  let progressTimer: number | undefined;
  let lastExecutionState: ResearchRunStatusView["execution_state"] | undefined;
  let historyController: AbortController | undefined;
  let historySerial = 0;
  let historyGeneration: string | undefined;
  let historyView: Awaited<ReturnType<typeof readResearchRunHistory>> | undefined;
  let disposed = false;

  const clearProgressTimer = (): void => {
    if (progressTimer !== undefined) {
      window.clearTimeout(progressTimer);
      progressTimer = undefined;
    }
  };

  const updateButtons = (): void => {
    const available = healthReady();
    const busy = controller !== undefined;
    submit.disabled = !available || busy;
    recover.disabled = !available || busy;
    refresh.disabled = !available || busy || workflowId === undefined;
    historyRefresh.disabled = !available || historyController !== undefined;
  };
  const stop = (): void => {
    serial += 1;
    clearProgressTimer();
    controller?.abort();
    controller = undefined;
    lastExecutionState = undefined;
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
    historyList.replaceChildren();
    historyStatus.textContent = "Recent research appears after the current session is ready.";
  };
  const clearPrivate = (): void => {
    stop(); clearHistory(); workflowId = undefined; workflowGeneration = undefined; selectedSourceId = undefined; previousBody = ""; idempotencyKey = "";
    workflowInput.value = ""; result.replaceChildren(); result.hidden = true; query.value = ""; scope.value = "library"; selectedOption.disabled = true;
    updateButtons(); status.textContent = "Private research state cleared. Reconnect before starting or loading a run.";
  };
  const onHealthUpdated = (): void => {
    const ready = healthReady();
    badge.textContent = ready ? "READY" : "WAITING";
    if (!ready) clearPrivate(); else { updateButtons(); scheduleStatusRefresh(true); loadHistory("automatic"); }
  };
  const onVisibilityChanged = (): void => {
    if (document.visibilityState === "hidden") {
      clearProgressTimer();
      if (historyController !== undefined) clearHistoryRequest();
      if (controller !== undefined) {
        serial += 1;
        controller.abort();
        controller = undefined;
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
        !healthReady() || !navigator.onLine || document.visibilityState === "hidden") return;
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
    note.textContent = `${historyStageText(entry.status)} · ${entry.status.answer.availability === "draft" ? "Draft available" : "No draft available"}`;
    row.append(open, note);
    return row;
  };
  const renderHistoryList = (view: Awaited<ReturnType<typeof readResearchRunHistory>>): void => {
    historyList.replaceChildren();
    if (view.configuration_state === "MISSING") {
      historyStatus.textContent = "Research configuration is missing on the server. Install it before starting a research run.";
    } else if (view.runs.length === 0) {
      historyStatus.textContent = "Configuration installed; run research to confirm execution. No saved runs are available yet.";
      return;
    } else {
      historyStatus.textContent = "Configuration installed; run research to confirm execution.";
    }
    view.runs.forEach((entry) => historyList.append(renderHistory(entry)));
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
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) { clearPrivate(); return; }
        historyGeneration = undefined;
        if (historyView !== undefined) renderHistoryList(historyView);
        historyStatus.textContent = historyErrorMessage(error);
      })
      .finally(() => { if (active === historySerial) { historyController = undefined; updateButtons(); } });
  };
  const renderStatus = (view: ResearchRunStatusView, artifact?: ArtifactRevision, renderSerial = serial): void => {
    lastExecutionState = view.execution_state;
    const text = statusText(view);
    result.replaceChildren();
    const heading = document.createElement("p"); const strong = document.createElement("strong"); strong.textContent = text; heading.append(strong);
    const identity = document.createElement("p"); identity.append("Run ID ", codeRef(view.workflow_instance_id), " · investigation ", codeRef(view.investigation_ref.id));
    result.append(heading);
    if (view.answer.availability === "draft" && artifact !== undefined) {
      const reportHead = document.createElement("div"); reportHead.className = "research-report-heading";
      const reportTitle = document.createElement("h3"); reportTitle.textContent = "Research draft";
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
      technicalField("Run ID", view.workflow_instance_id);
      technicalField("Investigation", `${view.investigation_ref.id}:${view.investigation_ref.revision}`);
      technicalField("Artifact", `${artifact.artifact_ref.id}:${artifact.artifact_ref.revision}`);
      technicalField("Specification", `${artifact.spec_ref.id}:${artifact.spec_ref.revision}`);
      technicalField("Evidence freeze", `${artifact.evidence_freeze_ref.id}:${artifact.evidence_freeze_ref.revision}`);
      technicalField("Status", artifact.status);
      technical.append(technicalSummary, technicalFields);
      result.append(reportHead, technical);
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
          if (renderSerial !== serial || controller !== undefined) return;
          const local = new AbortController(); controller = local; open.disabled = true; status.textContent = "Reading report section…";
          void readResearchArtifactSection(artifact.artifact_ref, section, local.signal)
            .then((readback) => {
              if (renderSerial !== serial) return;
              const body = document.createElement("pre"); body.className = "research-section-body"; body.textContent = decodeSectionBody(readback.bytes);
              item.querySelector(".research-section-body")?.remove(); item.append(body); status.textContent = "Report section opened.";
            })
            .catch((error: unknown) => {
              if (renderSerial !== serial || (error instanceof Error && error.name === "AbortError")) return;
              if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.status === 409 || error.status === 410)) { clearPrivate(); return; }
              const failure = document.createElement("p"); failure.className = "research-section-error"; failure.textContent = message(error); item.querySelector(".research-section-error")?.remove(); item.append(failure);
              status.textContent = "The report section could not be opened.";
            })
            .finally(() => { if (controller === local) { controller = undefined; open.disabled = false; updateButtons(); } });
        };
        const sources = document.createElement("button"); sources.type = "button"; sources.className = "button button--quiet"; sources.textContent = "Open sources"; sources.dataset.openSources = String(ordinal);
        sources.onclick = () => {
          if (renderSerial !== serial || controller !== undefined) return;
          const local = new AbortController(); controller = local; open.disabled = true; sources.disabled = true; status.textContent = "Reading cited sources…";
          item.querySelector(".research-citations")?.remove(); item.querySelector(".research-citation-error")?.remove();
          void readResearchArtifactSectionCitations(artifact.artifact_ref, section.section_ref, view.deployment_generation, local.signal, section.verification_receipt_ref)
            .then((citations) => {
              if (renderSerial !== serial) return;
              const list = document.createElement("div"); list.className = "research-citations";
              const state = document.createElement("p"); state.className = "research-citation-state";
              state.textContent = "Draft claims have not been checked. Opening a source checks its current bytes.";
              list.append(state);
              if (citations.cited_evidence.length === 0) {
                const empty = document.createElement("p"); empty.textContent = "No cited source handles are available."; list.append(empty);
              } else {
                const heading = document.createElement("p"); heading.textContent = "Open a cited source in the Evidence rail:"; list.append(heading);
                const actions = document.createElement("div"); actions.className = "research-citation-actions";
                citations.cited_evidence.forEach((citation, citationOrdinal) => {
                  const button = document.createElement("button"); button.type = "button"; button.className = "button button--quiet"; button.textContent = `Open source ${citationOrdinal + 1}`; button.dataset.openCitation = String(citationOrdinal);
                  button.onclick = () => {
                    if (renderSerial !== serial || controller !== undefined) return;
                    element.dispatchEvent(new CustomEvent("research:evidence-selected", { bubbles: true, detail: { scopeSnapshotRef: citations.scope_snapshot_ref, handleRef: citation.handle_ref, excerptSha256: citation.excerpt_sha256 } }));
                    status.textContent = "Source selected. Verify it in the Evidence rail.";
                  };
                  actions.append(button);
                });
                list.append(actions);
              }
              item.append(list); status.textContent = "Cited sources loaded; fresh verification is still required.";
            })
            .catch((error: unknown) => {
              if (renderSerial !== serial || (error instanceof Error && error.name === "AbortError")) return;
              if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.status === 409 || error.status === 410)) { clearPrivate(); return; }
              const failure = document.createElement("p"); failure.className = "research-citation-error"; failure.textContent = message(error); item.querySelector(".research-citation-error")?.remove(); item.append(failure);
              status.textContent = "Cited sources could not be read.";
            })
            .finally(() => { if (controller === local) { controller = undefined; open.disabled = false; sources.disabled = false; updateButtons(); } });
        };
        const actions = document.createElement("div"); actions.className = "research-report-actions"; actions.append(open, sources);
        item.append(sectionHeading, sectionTechnical, actions); sections.append(item);
      });
      result.append(sections);
    } else {
      result.append(identity);
    }
    result.hidden = false;
    if (status.textContent !== text) status.textContent = text;
    refresh.disabled = false;
    if (view.execution_state === "ACTIVE") scheduleStatusRefresh(); else clearProgressTimer();
  };
  const readStatus = (trigger: "manual" | "automatic" | "history" = "manual", requestedWorkflowId?: string): void => {
    if (trigger === "automatic" && (lastExecutionState !== "ACTIVE" || controller !== undefined)) {
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
    void readResearchRunStatus(id, expectedGeneration, local.signal)
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
        lastExecutionState = undefined; clearProgressTimer();
        const privateFailure = error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED");
        if (!automatic || privateFailure) { result.replaceChildren(); result.hidden = true; }
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) {
          if (error.status === 409 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED") clearPrivate(); else status.textContent = message(error);
        } else status.textContent = message(error);
      })
      .finally(() => { if (active === serial) { controller = undefined; updateButtons(); scheduleStatusRefresh(); } });
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const generation = deploymentGeneration();
    if (!healthReady() || !navigator.onLine || generation === undefined) { status.textContent = "Owner workspace is unavailable. Reconnect before starting research."; return; }
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
      .then((view) => { if (active !== serial) return; workflowId = view.workflow_instance_id; workflowGeneration = view.deployment_generation; workflowInput.value = view.workflow_instance_id; lastExecutionState = "ACTIVE"; refresh.disabled = false; status.textContent = "Research started. Checking progress automatically."; loadHistory("manual", true); })
      .catch((error: unknown) => { if (active !== serial || (error instanceof Error && error.name === "AbortError")) return; if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) clearPrivate(); else status.textContent = message(error); })
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
    selectSource(id: string, context?: LibrarySelectionContext): void {
      IdentifierSchema.parse(id); stop(); workflowId = undefined; workflowGeneration = undefined; previousBody = ""; idempotencyKey = ""; result.replaceChildren(); result.hidden = true;
      selectedSourceId = id; workflowInput.value = ""; updateButtons(); selectedOption.disabled = false; scope.value = "selected"; status.textContent = context?.sourceRevisionRef ? "Selected source ready for a research run." : "Selected source loaded; refresh the Library before starting.";
    },
  });
}
