import { createResearchConnection, isResearchConnectionFailure } from "./research-run-connection.js";
import { renderResearchArtifactReport, type ReportRenderOptions } from "./research-run-report.js";
import { mountResearchRunControls, openRunArtifact, runArtifactRenderOptions, type OpenedRunArtifact } from "./research-run-controls.js";
import { IdentifierSchema } from "@eliotr/contracts";
import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import { readResearchRunHistory, researchRunBody, readReauthorizedResearchArtifact, readResearchRunStatus, startResearchRun, type ResearchEngineStatus, type ResearchRunHistoryEntry, type ResearchRunSavedDraft, type ResearchRunStatusView } from "./research-run-api.js"; import { finishResearchStatusRead, readResearchStatusWithAuthorityRetry, shouldRetryResearchAuthority } from "./research-run-status-retry.js";
import type { ArtifactRevision } from "@eliotr/contracts";
import type { LibrarySelectionContext } from "./library-readiness-api.js";
import { currentResearchRunBadge, RESEARCH_STATUS_REFRESH_MS, message, statusText, badgeText, idleBadgeText, idleProgressText, historyNoteText, historyStatusText,  shouldPollEngine, historyErrorMessage, sameArtifact, createResearchRunView, createResearchHistoryRow, renderResearchHistoryList, renderResearchStatusHeading } from "./research-run-view.js";
export function mountResearchRunPanel(
  element: HTMLElement,
  deploymentGeneration: () => string | undefined,
  healthReady: () => boolean = () => false,
  researchConfigurationReady: () => boolean = () => true,
): (() => void) & { clearPrivate(notice?: string): void; suspendPrivate(): void; refreshAvailability(): void; invalidateSourceRevision(): void; selectSource(id: string, context?: LibrarySelectionContext): void; setProject(projectId?: string, title?: string): void } {
  const { form, badge, progress, query, scope, projectOption, selectedOption, submit, refresh, workflowInput, recover, status, result, historyRefresh, historyStatus, historyList } = createResearchRunView(element, healthReady(), researchConfigurationReady());
  let serial = 0; let controller: AbortController | undefined;
  let workflowId: string | undefined; let workflowGeneration: string | undefined; let selectedSourceId: string | undefined; let selectedProjectId: string | undefined;
  let previousBody = ""; let idempotencyKey = ""; let unconfirmedStart = false; let suspended = false;
  let reconnecting: Promise<void> | undefined; let progressTimer: number | undefined;
  let lastExecutionState: ResearchRunStatusView["execution_state"] | undefined; let lastEngineStatus: ResearchEngineStatus | undefined; let lastAnswerAvailability: ResearchRunStatusView["answer"]["availability"] | undefined;
  let historyController: AbortController | undefined; let historySerial = 0; let historyGeneration: string | undefined; let historyView: Awaited<ReturnType<typeof readResearchRunHistory>> | undefined;
  const historyRows = new Map<string, HTMLElement>(); let disposed = false;
  const clearProgressTimer = (): void => {
    if (progressTimer !== undefined) { window.clearTimeout(progressTimer); progressTimer = undefined; }
  };
  const updateButtons = (): void => {
    const available = healthReady() && navigator.onLine;
    const startAvailable = available && connection?.ready === true && researchConfigurationReady();
    const busy = controller !== undefined || runControls?.busy === true || connection?.checking === true;
    query.disabled = connection?.hasIdentity !== true;
    submit.disabled = !startAvailable || busy;
    recover.disabled = !available || busy;
    refresh.disabled = !available || busy || workflowId === undefined;
    historyRefresh.disabled = !available || historyController !== undefined || busy;
    runControls?.refresh();
  };
  const setReportActionsDisabled = (disabled: boolean): void => {
    result.querySelectorAll<HTMLButtonElement>(".research-report-actions > button, .research-citation-actions > button").forEach((button) => { button.disabled = disabled || connection?.ready !== true || button.dataset.reportActionUnavailable === "true"; });
  };
  const finishReportAction = (local: AbortController, renderSerial: number): void => {
    if (controller !== local) return;
    controller = undefined; if (disposed || renderSerial !== serial) return; setReportActionsDisabled(false); updateButtons();
  };
  const refreshAvailability = (): void => {
    badge.textContent = currentResearchRunBadge(lastExecutionState, lastEngineStatus, lastAnswerAvailability, healthReady(), researchConfigurationReady());
    if (suspended) { badge.textContent = "RECONNECT REQUIRED"; progress.textContent = "Input retained in this tab; private responses cleared. Reconnect to verify the owner and read the same run."; }
    else if (lastExecutionState === undefined) progress.textContent = idleProgressText(healthReady(), researchConfigurationReady());
    updateButtons();
  };
  const stop = (preserveCommands = false): void => {
    serial += 1;
    if (preserveCommands) runControls?.suspend(); else runControls?.clear();
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
    reconnecting = undefined; connection?.reset(); suspended = false; unconfirmedStart = false;
    stop(); clearHistory(); workflowId = undefined; workflowGeneration = undefined; selectedSourceId = undefined; previousBody = ""; idempotencyKey = "";
    workflowInput.value = ""; result.replaceChildren(); result.hidden = true; query.value = ""; scope.value = "library"; projectOption.disabled = true; projectOption.textContent = "Selected project"; selectedOption.disabled = true; selectedProjectId = undefined;
    badge.textContent = idleBadgeText(healthReady(), researchConfigurationReady()); progress.textContent = idleProgressText(healthReady(), researchConfigurationReady());
    updateButtons(); status.textContent = notice;
  };
  const showUnavailableRun = (error: ApiRequestError): void => {
    clearPrivate();
    progress.textContent = "Saved research is unavailable.";
    status.textContent = `Saved research is unavailable. ${message(error)}`;
    console.warn("research_run_read_failed", JSON.stringify({ code: error.code, status: error.status }));
  };
  const clearDisconnectedResponses = (): void => {
    reconnecting = undefined; suspended = true;
    stop(true); clearHistory(); result.replaceChildren(); result.hidden = true;
    projectOption.textContent = "Selected project";
    element.dispatchEvent(new CustomEvent("research:private-cleared", { bubbles: true }));
    status.textContent = unconfirmedStart
      ? "Start outcome is unknown. Input and original request key are retained; reconnect and retry only the unchanged request explicitly."
      : "Connection interrupted. Input and run reference are retained in this tab; no run or upload will be restarted automatically.";
    refreshAvailability();
  };
  const suspendPrivate = (): void => connection?.suspend();
  const connectionFailed = (error: unknown): boolean => {
    if (!isResearchConnectionFailure(error)) return false;
    suspendPrivate(); return true;
  };
  const responseIsCurrent = (active: number, local: AbortController, history = false): boolean => {
    if (disposed || local.signal.aborted || active !== (history ? historySerial : serial)) return false;
    if (!connection.ready) { suspendPrivate(); return false; }
    return true;
  };
  const resumeConnection = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (reconnecting !== undefined) return reconnecting;
    const gate = connection;
    if (gate === undefined) return Promise.resolve();
    const task = gate.refresh().then((verified) => {
      if (!verified || disposed || !gate.ready) return;
      suspended = false; refreshAvailability();
      if (workflowId !== undefined) readStatus("reconnect", workflowId);
      else status.textContent = unconfirmedStart
        ? "Owner verified. The last start is still unconfirmed; an explicit retry of unchanged input keeps its original request key."
        : "Owner verified. Your question is ready; nothing was submitted automatically.";
      loadHistory("automatic");
    }).finally(() => { if (reconnecting === task) reconnecting = undefined; });
    reconnecting = task;
    return task;
  };
  const onHealthUpdated = (): void => {
    if (!healthReady()) suspendPrivate();
    else if (connection?.ready !== true || suspended) void resumeConnection();
    else { refreshAvailability(); scheduleStatusRefresh(true); loadHistory("automatic"); }
  };
  const onVisibilityChanged = (): void => {
    if (document.visibilityState === "hidden") {
      runControls?.interrupt();
      updateButtons();
      clearProgressTimer();
      if (historyController !== undefined) clearHistoryRequest();
        if (controller !== undefined) {
          serial += 1;
          controller.abort();
          controller = undefined;
          setReportActionsDisabled(false);
          if (unconfirmedStart) status.textContent = "Start response interrupted. Input and request key retained; retry the unchanged request explicitly after reconnecting.";
          updateButtons();
        }
      return;
    }
    if (connection?.ready !== true) { suspendPrivate(); if (healthReady()) void resumeConnection(); return; }
    updateButtons(); scheduleStatusRefresh(true);
    if (healthReady()) loadHistory("automatic");
  };
  const connection = createResearchConnection({ generation: deploymentGeneration, healthReady,
    changed: updateButtons, suspended: clearDisconnectedResponses, denied: clearPrivate });
  const runControls = mountResearchRunControls(element, status, {
    available: () => !disposed && connection?.ready === true && healthReady() && navigator.onLine && controller === undefined && document.visibilityState !== "hidden",
    generation: deploymentGeneration,
    changed: () => { clearProgressTimer(); setReportActionsDisabled(runControls?.busy === true); updateButtons(); },
    confirmed: (view) => renderStatus(view), refreshStatus: (id) => readStatus("manual", id), clearPrivate, connectionFailed,
  });
  window.addEventListener("eliotr:health-updated", onHealthUpdated);
  document.addEventListener("visibilitychange", onVisibilityChanged);
  updateButtons();
  const scheduleStatusRefresh = (immediate = false): void => {
    clearProgressTimer();
    if (disposed || suspended || connection?.ready !== true || runControls?.busy === true || lastExecutionState !== "ACTIVE" || workflowId === undefined || controller !== undefined ||
        !shouldPollEngine(lastEngineStatus) || !healthReady() || !navigator.onLine || document.visibilityState === "hidden") return;
    progressTimer = window.setTimeout(() => {
      progressTimer = undefined;
      readStatus("automatic");
    }, immediate ? 0 : RESEARCH_STATUS_REFRESH_MS);
  };
  const renderHistory = (entry: ResearchRunHistoryEntry): HTMLElement => {
    const { row, open } = createResearchHistoryRow(entry.created_at, historyNoteText(entry.status), false);
    open.onclick = () => {
      if (disposed || !open.isConnected || open.closest("[data-research-history-list]") !== historyList || !healthReady() || !navigator.onLine || historyView?.deployment_generation !== entry.status.deployment_generation) return;
      readStatus("history", entry.status.workflow_instance_id);
    };
    historyRows.set(entry.status.workflow_instance_id, row);
    return row;
  };
  const renderSavedDraft = (draft: ResearchRunSavedDraft, generation: string): HTMLElement => {
    const { row, open } = createResearchHistoryRow(draft.created_at, "Draft available", true);
    open.onclick = () => {
      if (disposed || !open.isConnected || open.closest("[data-research-history-list]") !== historyList || !healthReady() || !navigator.onLine || deploymentGeneration() !== generation || historyView?.deployment_generation !== generation) return;
      readSavedDraft(draft);
    };
    return row;
  };
  const renderHistoryList = (view: Awaited<ReturnType<typeof readResearchRunHistory>>): void => {
    historyRows.clear();
    renderResearchHistoryList(historyList, historyStatus, view, (card) => "entry" in card ? renderHistory(card.entry) : renderSavedDraft(card.draft, view.deployment_generation));
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
    if (connection?.ready !== true) { if (trigger === "manual") void resumeConnection(); return; }
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
      .then((view) => { if (!responseIsCurrent(active, local, true)) return; historyGeneration = view.deployment_generation; historyView = view; renderHistoryList(view); })
      .catch((error: unknown) => {
        if (active !== historySerial || (error instanceof Error && error.name === "AbortError")) return;
        if (isResearchConnectionFailure(error)) { suspendPrivate(); return; }
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
  const renderArtifactReport = (artifact: ArtifactRevision, options: ReportRenderOptions): void => renderResearchArtifactReport(artifact, options, {
    element, result, status, isCurrent: (active) => active === serial && connection.ready && !disposed,
    busy: () => controller !== undefined || !connection.ready, connectionFailed,
    disposed: () => disposed, generation: deploymentGeneration, setController: (local) => { controller = local; },
    clearPrivate, setActionsDisabled: setReportActionsDisabled, finishAction: finishReportAction,
  });
  const readSavedDraft = (draft: ResearchRunSavedDraft): void => {
    if (runControls?.busy) return;
    if (connection?.ready !== true) { void resumeConnection(); return; }
    runControls?.show();
    const generation = deploymentGeneration();
    if (disposed || !healthReady() || !navigator.onLine || generation === undefined) { status.textContent = "Owner workspace is unavailable. Reconnect before opening saved research."; return; }
    clearProgressTimer();
    const active = ++serial; controller?.abort(); const local = new AbortController(); controller = local;
    workflowId = undefined; workflowGeneration = undefined; workflowInput.value = "";
    lastExecutionState = undefined; lastEngineStatus = undefined; lastAnswerAvailability = undefined;
    result.replaceChildren(); result.hidden = true; badge.textContent = "WAITING"; progress.textContent = "Opening saved research…"; status.textContent = "Opening saved research…"; updateButtons();
    void readReauthorizedResearchArtifact(draft.artifact_ref, generation, local.signal)
      .then((reauthorized) => {
        if (!responseIsCurrent(active, local)) return;
        lastExecutionState = "ENGINE_COMPLETED"; lastEngineStatus = "complete"; lastAnswerAvailability = "draft";
        badge.textContent = "DRAFT"; progress.textContent = "Saved draft opened for review."; result.replaceChildren();
        renderArtifactReport(reauthorized.artifact, { renderSerial: active, deploymentGeneration: reauthorized.deployment_generation, historical: true, ...(draft.workflow_instance_id === undefined ? {} : { workflowInstanceId: draft.workflow_instance_id }), authorizationScopeSnapshotRef: reauthorized.authorization_scope_snapshot_ref, sourceFreshness: reauthorized.source_freshness });
        result.hidden = false; status.textContent = "Saved draft opened. Open a section to recheck its sources."; setReportActionsDisabled(true);
      })
      .catch((error: unknown) => {
        if (active !== serial || (error instanceof Error && error.name === "AbortError")) return;
        if (connectionFailed(error)) return;
        if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 403 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) { clearPrivate(); return; }
        lastExecutionState = undefined; lastEngineStatus = undefined; lastAnswerAvailability = undefined; result.replaceChildren(); result.hidden = true;
        badge.textContent = idleBadgeText(healthReady(), researchConfigurationReady()); progress.textContent = "Saved draft could not be opened."; status.textContent = message(error);
      })
      .finally(() => { if (active === serial) { controller = undefined; if (!disposed) setReportActionsDisabled(false); updateButtons(); } });
  };
  const renderStatus = (view: ResearchRunStatusView, opened?: OpenedRunArtifact, renderSerial = serial): void => {
    runControls?.show(view);
    lastExecutionState = view.execution_state;
    lastEngineStatus = view.engine_status;
    lastAnswerAvailability = view.answer.availability;
    updateHistoryStatus(view);
    const text = statusText(view);
    badge.textContent = badgeText(view);
    progress.textContent = text;
    const identity = renderResearchStatusHeading(result, view);
    if (view.answer.availability === "draft" && opened !== undefined) {
      renderArtifactReport(opened.artifact, runArtifactRenderOptions(view, opened, renderSerial));
    } else {
      result.append(identity);
    }
    result.hidden = false;
    setReportActionsDisabled(controller !== undefined);
    if (status.textContent !== text) status.textContent = text;
    refresh.disabled = false;
    if (view.execution_state === "ACTIVE" && shouldPollEngine(view.engine_status)) scheduleStatusRefresh(); else clearProgressTimer();
  };
  const readStatus = (trigger: "manual" | "automatic" | "history" | "reconnect" = "manual", requestedWorkflowId?: string): void => {
    if (runControls?.busy) return;
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
    if (connection?.ready !== true) { void resumeConnection(); return; }
    if (!healthReady() || !navigator.onLine || deploymentGeneration() === undefined) { status.textContent = "Owner workspace is unavailable. Reconnect before reading research."; return; }
    clearProgressTimer();
    const active = ++serial; controller?.abort(); const local = new AbortController(); controller = local;
    if (!automatic) {
      result.replaceChildren(); result.hidden = true; submit.disabled = true; recover.disabled = true; refresh.disabled = true; status.textContent = "Reading research status…";
    }
    runControls?.show();
    const expectedGeneration = id === workflowId ? (workflowGeneration ?? deploymentGeneration()) : deploymentGeneration();
    workflowId = id; workflowGeneration = expectedGeneration;
    const canRetryAuthority = (error: unknown): boolean => shouldRetryResearchAuthority(error, { automatic, requestedId: id, workflowId, expectedGeneration, isCurrent: () => active === serial, currentGeneration: deploymentGeneration, healthReady, online: () => navigator.onLine, visible: () => document.visibilityState !== "hidden" });
    void readResearchStatusWithAuthorityRetry(() => readResearchRunStatus(id, expectedGeneration, local.signal), canRetryAuthority, () => { status.textContent = "Refreshing research status…"; })
      .then(async (view) => {
        if (!responseIsCurrent(active, local)) return;
        const artifact = await openRunArtifact(view, local.signal);
        if (!responseIsCurrent(active, local)) return;
        workflowId = view.workflow_instance_id; workflowGeneration = view.deployment_generation;
        if (trigger !== "history" && (!automatic || workflowInput.value.trim() === id)) workflowInput.value = view.workflow_instance_id;
        renderStatus(view, artifact);
      })
      .catch((error: unknown) => {
        if (active !== serial || (error instanceof Error && error.name === "AbortError")) return;
        if (isResearchConnectionFailure(error)) { suspendPrivate(); return; }
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
          if (error.status === 409 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED") showUnavailableRun(error);
          else if (error.status === 401 || error.status === 403) clearPrivate("Research access was denied. Private state and retained input were cleared.");
          else { workflowId = undefined; workflowGeneration = undefined; workflowInput.value = ""; status.textContent = message(error); }
        } else status.textContent = message(error);
      })
      .finally(() => finishResearchStatusRead(active === serial, () => { controller = undefined; }, disposed, () => setReportActionsDisabled(false), updateButtons, scheduleStatusRefresh));
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (runControls?.busy || controller !== undefined) return;
    if (connection?.ready !== true) { void resumeConnection(); return; }
    const generation = deploymentGeneration();
    if (!healthReady() || !navigator.onLine || generation === undefined) { status.textContent = "Owner workspace is unavailable. Reconnect before starting research."; return; }
    if (!researchConfigurationReady()) { status.textContent = "Research configuration is not ready. Check the Research configuration card before starting a run."; return; }
    if (scope.value === "project" && selectedProjectId === undefined) { status.textContent = "Select a project before starting research."; return; }
    if (scope.value === "selected" && selectedSourceId === undefined) { status.textContent = "Select a source before starting research."; return; }
    const ids = scope.value === "selected" ? [selectedSourceId as string] : [];
    let body: string;
    try { body = researchRunBody(query.value, ids, 16, scope.value === "project" ? selectedProjectId : undefined); } catch (error: unknown) { status.textContent = message(error); return; }
    if (unconfirmedStart && previousBody !== body) {
      status.textContent = "The previous start is unconfirmed. Restore its original question and scope to retry the same request; do not create a replacement."; return;
    }
    runControls?.show(); clearProgressTimer(); lastExecutionState = undefined;
    const active = ++serial; const local = new AbortController(); controller = local;
    if (body !== previousBody) { previousBody = body; idempotencyKey = crypto.randomUUID(); }
    unconfirmedStart = true;
    workflowId = undefined; workflowGeneration = undefined; workflowInput.value = "";
    submit.disabled = true; refresh.disabled = true; recover.disabled = true; result.replaceChildren(); result.hidden = true; status.textContent = "Starting the research run…";
    element.dispatchEvent(new CustomEvent("research:started", { bubbles: true }));
    void startResearchRun(body, idempotencyKey, generation, local.signal)
      .then((view) => { if (!responseIsCurrent(active, local)) return; unconfirmedStart = false; workflowId = view.workflow_instance_id; workflowGeneration = view.deployment_generation; workflowInput.value = view.workflow_instance_id; lastExecutionState = "ACTIVE"; lastEngineStatus = undefined; lastAnswerAvailability = undefined; badge.textContent = "RUNNING"; progress.textContent = "Research started. Checking progress automatically."; refresh.disabled = false; status.textContent = "Research started. Checking progress automatically."; loadHistory("manual", true); })
      .catch((error: unknown) => { if (active !== serial || (error instanceof Error && error.name === "AbortError")) return; if (isResearchConnectionFailure(error)) { suspendPrivate(); return; } if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 403 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) clearPrivate(); else { badge.textContent = idleBadgeText(healthReady(), researchConfigurationReady()); progress.textContent = "Start not confirmed. An explicit unchanged retry retains the same request key."; status.textContent = message(error); } })
      .finally(() => { if (active === serial) { controller = undefined; updateButtons(); scheduleStatusRefresh(); } });
  };
  refresh.onclick = () => readStatus("manual", workflowId);
  recover.onclick = () => readStatus();
  historyRefresh.onclick = () => loadHistory("manual", true);
  const cleanup = (): void => {
    disposed = true;
    connection?.dispose();
    runControls?.dispose();
    window.removeEventListener("eliotr:health-updated", onHealthUpdated);
    document.removeEventListener("visibilitychange", onVisibilityChanged);
    clearPrivate();
  };
  if (healthReady()) void resumeConnection();
  return Object.assign(cleanup, {
    clearPrivate, suspendPrivate,
    refreshAvailability,
    invalidateSourceRevision(): void {
      if (disposed || result.hidden || result.querySelector(".research-report-heading") === null) return;
      stop(); workflowId = undefined; workflowGeneration = undefined; workflowInput.value = "";
      result.replaceChildren(); result.hidden = true;
      badge.textContent = idleBadgeText(healthReady(), researchConfigurationReady());
      progress.textContent = "Source revisions changed. Reopen saved research to review the updated source versions.";
      status.textContent = "Source revisions changed. Reopen saved research to review the updated source versions.";
      updateButtons();
    },
    setProject(projectId?: string, title?: string): void {
      if (projectId !== undefined) IdentifierSchema.parse(projectId);
      const desiredScope = projectId === undefined ? "library" : "project";
      const changed = selectedProjectId !== projectId || scope.value !== desiredScope;
      if (changed) {
        stop(); workflowId = undefined; workflowGeneration = undefined;
        workflowInput.value = ""; result.replaceChildren(); result.hidden = true;
        badge.textContent = idleBadgeText(healthReady(), researchConfigurationReady());
        progress.textContent = idleProgressText(healthReady(), researchConfigurationReady());
      }
      if (projectId === undefined) {
        selectedProjectId = undefined; projectOption.disabled = true; projectOption.textContent = "Selected project";
        scope.value = "library";
        updateButtons();
        return;
      }
      selectedProjectId = projectId; projectOption.disabled = false;
      const projectTitle = typeof title === "string" && title.trim().length > 0 ? title.trim() : "Selected project";
      projectOption.textContent = projectTitle;
      scope.value = "project"; updateButtons(); status.textContent = "Selected project ready for a research run.";
    },
    selectSource(id: string, context?: LibrarySelectionContext): void {
      IdentifierSchema.parse(id); stop(); workflowId = undefined; workflowGeneration = undefined; result.replaceChildren(); result.hidden = true;
      selectedSourceId = id; workflowInput.value = ""; updateButtons(); selectedOption.disabled = false; scope.value = "selected"; status.textContent = context?.sourceRevisionRef ? "Selected source ready for a research run." : "Selected source loaded; refresh the Library before starting.";
    },
  });
}
