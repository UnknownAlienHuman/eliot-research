import { IdentifierSchema } from "@eliotr/contracts";
import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import { readResearchRunHistory, researchRunBody, readResearchArtifact, readReauthorizedResearchArtifact, readReauthorizedResearchArtifactSection, readResearchRunStatus, startResearchRun, type ResearchArtifactSectionCitationAuditClaim, type ResearchEngineStatus, type ResearchRunHistoryEntry, type ResearchRunSavedDraft, type ResearchSourceFreshness, type ResearchRunStatusView } from "./research-run-api.js"; import { readReauthorizedResearchArtifactSectionCitations } from "./research-run-reauthorization-api.js"; import { finishResearchStatusRead, readResearchStatusWithAuthorityRetry, shouldRetryResearchAuthority } from "./research-run-status-retry.js";
import { downloadResearchDraftMarkdown, type ResearchMarkdownSection } from "./research-markdown-download.js";
import { createWikiProposalFromRun } from "./wiki-proposal-create-api.js";
import type { ArtifactRevision } from "@eliotr/contracts";
import type { LibrarySelectionContext } from "./library-readiness-api.js";
import { RESEARCH_STATUS_REFRESH_MS, AUDIT_DISPOSITION_LABELS, message, statusText, badgeText, idleBadgeText, idleProgressText, wikiProposalErrorText, auditStatusText, historyNoteText, historyStatusText, shouldPollEngine, historyErrorMessage, decodeSectionBody, codeRef, citationRefKey, sameArtifact, renderResearchSourceFreshnessNotice, createResearchRunView, createResearchHistoryRow, researchHistoryCards, renderResearchStatusHeading, createResearchReportHeader } from "./research-run-view.js";
export function mountResearchRunPanel(
  element: HTMLElement,
  deploymentGeneration: () => string | undefined,
  healthReady: () => boolean = () => false,
  researchConfigurationReady: () => boolean = () => true,
): (() => void) & { clearPrivate(notice?: string): void; refreshAvailability(): void; invalidateSourceRevision(): void; selectSource(id: string, context?: LibrarySelectionContext): void; setProject(projectId?: string, title?: string): void } {
  const { form, badge, progress, query, scope, projectOption, selectedOption, submit, refresh, workflowInput, recover, status, result, historyRefresh, historyStatus, historyList } = createResearchRunView(element, healthReady(), researchConfigurationReady());
  let serial = 0; let controller: AbortController | undefined;
  let workflowId: string | undefined; let workflowGeneration: string | undefined; let selectedSourceId: string | undefined; let selectedProjectId: string | undefined;
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
      ? idleBadgeText(healthReady(), researchConfigurationReady())
      : lastExecutionState === "ACTIVE"
        ? (lastEngineStatus === "errored" || lastEngineStatus === "terminated" ? "FAILED" : "RUNNING")
        : lastExecutionState === "CANCELLED" ? "CANCELLED" : lastAnswerAvailability === "draft" ? "DRAFT" : "COMPLETE";
    if (lastExecutionState === undefined) progress.textContent = idleProgressText(healthReady(), researchConfigurationReady());
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
    historyList.replaceChildren();
    historyStatus.textContent = historyStatusText(view);
    researchHistoryCards(view).forEach((card) => historyList.append("entry" in card ? renderHistory(card.entry) : renderSavedDraft(card.draft, view.deployment_generation)));
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
  type ReportRenderOptions = { readonly renderSerial: number; readonly deploymentGeneration: string; readonly historical: boolean; readonly workflowInstanceId?: string; readonly investigationRef?: string; readonly authorizationScopeSnapshotRef?: { readonly id: string; readonly revision: number }; readonly sourceFreshness?: ResearchSourceFreshness };
  const renderArtifactReport = (artifact: ArtifactRevision, options: ReportRenderOptions): void => {
    const { reportHead, technical } = createResearchReportHeader(artifact, options);
    const reportActions = document.createElement("div"); reportActions.className = "research-report-actions";
    const download = document.createElement("button"); download.type = "button"; download.className = "button button--quiet"; download.textContent = "Download Markdown";
    if (artifact.sections.length === 0) {
      download.disabled = true; download.dataset.reportActionUnavailable = "true";
      const empty = document.createElement("p"); empty.className = "research-download-status"; empty.textContent = "This draft has no report sections to download."; reportActions.append(empty);
    }
    const workflowInstanceId = options.workflowInstanceId;
    const previousSourceRevisions = options.sourceFreshness?.state === "PREVIOUS_REVISIONS";
    const createWikiDraft = workflowInstanceId !== undefined && !previousSourceRevisions ? document.createElement("button") : undefined;
    const wikiDraftStatus = createWikiDraft === undefined ? undefined : document.createElement("p");
    if (workflowInstanceId !== undefined && previousSourceRevisions) {
      const note = document.createElement("p"); note.className = "research-wiki-draft-status";
      note.textContent = "Start new Research on the updated sources before creating a Wiki draft."; reportActions.append(note);
    }
    if (workflowInstanceId !== undefined && createWikiDraft !== undefined && wikiDraftStatus !== undefined) {
      const capturedWorkflowInstanceId = workflowInstanceId;
      const idempotencyKey = `wiki-from-run:${workflowInstanceId}`;
      createWikiDraft.type = "button";
      createWikiDraft.className = "button button--quiet";
      createWikiDraft.textContent = "Create Wiki draft";
      wikiDraftStatus.className = "research-wiki-draft-status";
      wikiDraftStatus.hidden = true;
      wikiDraftStatus.setAttribute("role", "status");
      createWikiDraft.onclick = () => {
        if (options.renderSerial !== serial || controller !== undefined || disposed) return;
        const generation = deploymentGeneration();
        if (generation === undefined || generation !== options.deploymentGeneration) {
          clearPrivate("The Research workspace changed. Refresh before creating a Wiki draft.");
          return;
        }
        const local = new AbortController();
        controller = local;
        setReportActionsDisabled(true);
        wikiDraftStatus.hidden = false;
        wikiDraftStatus.textContent = "Saving this report as a Wiki draft…";
        status.textContent = "Saving this report as a Wiki draft…";
        void createWikiProposalFromRun(capturedWorkflowInstanceId, idempotencyKey, generation, local.signal)
          .then(() => {
            if (options.renderSerial !== serial || disposed || deploymentGeneration() !== options.deploymentGeneration) return;
            createWikiDraft.disabled = true;
            createWikiDraft.dataset.reportActionUnavailable = "true";
            wikiDraftStatus.textContent = "Saved as a Wiki draft. Open Wiki to review it.";
            status.textContent = "Wiki draft saved.";
            const openWiki = document.createElement("button");
            openWiki.type = "button";
            openWiki.className = "button button--quiet";
            openWiki.textContent = "Open Wiki";
            openWiki.onclick = () => { if (!disposed && options.renderSerial === serial) window.location.hash = "#wiki-card"; };
            reportActions.append(openWiki);
            window.dispatchEvent(new Event("eliotr:wiki-proposal-created"));
          })
          .catch((error: unknown) => {
            if (options.renderSerial !== serial || disposed || local.signal.aborted) return;
            if (deploymentGeneration() !== options.deploymentGeneration) {
              clearPrivate("The Research workspace changed. Refresh before creating a Wiki draft.");
              return;
            }
            if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.code === "WIKI_DEPLOYMENT_CHANGED" || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) {
              clearPrivate(error.code === "WIKI_DEPLOYMENT_CHANGED" || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED" ? "The Research workspace changed. Refresh before creating a Wiki draft." : "Authorization changed. Sign in again before creating a Wiki draft.");
              return;
            }
            wikiDraftStatus.hidden = false;
            wikiDraftStatus.textContent = wikiProposalErrorText(error);
            status.textContent = "Wiki draft could not be saved.";
          })
          .finally(() => finishReportAction(local, options.renderSerial));
      };
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
          const markdownSection: ResearchMarkdownSection = {
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
             citations: citations.cited_evidence.map((citation) => ({
               originalHandleRef: citationRefKey(citation.original_handle_ref),
               handleRef: citationRefKey(citation.handle_ref),
               excerptSha256: citation.excerpt_sha256,
             })),
             ...(citations.semantic_verification === "EXECUTED" ? {
               audit: {
                 stageAttemptRef: citations.audit.stage_attempt_ref,
                 stageRequestSha256: citations.audit.stage_request_sha256,
                 outputSha256: citations.audit.output_sha256,
                 synthesisOutputSha256: citations.audit.synthesis_output_sha256,
                 normalizationBindingSha256: citations.audit.normalization_binding_sha256,
                 verifierRef: citations.audit.verifier_ref,
                 verifierSchemaGeneration: citations.audit.verifier_schema_generation,
                 modelReceiptRef: citations.audit.model_receipt_ref,
               },
             } : {}),
           };
           sections.push(markdownSection);
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
    reportActions.append(download);
    if (createWikiDraft !== undefined && wikiDraftStatus !== undefined) reportActions.append(createWikiDraft, wikiDraftStatus);
    const freshnessNotice = options.sourceFreshness === undefined ? undefined : renderResearchSourceFreshnessNotice(options.sourceFreshness);
    result.append(reportHead, ...(freshnessNotice === undefined ? [] : [freshnessNotice]), technical, reportActions);
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
        renderArtifactReport(reauthorized.artifact, { renderSerial: active, deploymentGeneration: reauthorized.deployment_generation, historical: true, ...(draft.workflow_instance_id === undefined ? {} : { workflowInstanceId: draft.workflow_instance_id }), authorizationScopeSnapshotRef: reauthorized.authorization_scope_snapshot_ref, sourceFreshness: reauthorized.source_freshness });
        result.hidden = false; status.textContent = "Saved draft opened. Open a section to recheck its sources."; setReportActionsDisabled(true);
      })
      .catch((error: unknown) => {
        if (active !== serial || (error instanceof Error && error.name === "AbortError")) return;
        if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) { clearPrivate(); return; }
        lastExecutionState = undefined; lastEngineStatus = undefined; lastAnswerAvailability = undefined; result.replaceChildren(); result.hidden = true;
        badge.textContent = idleBadgeText(healthReady(), researchConfigurationReady()); progress.textContent = "Saved draft could not be opened."; status.textContent = message(error);
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
    const identity = renderResearchStatusHeading(result, view);
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
    if (scope.value === "project" && selectedProjectId === undefined) { status.textContent = "Select a project before starting research."; return; }
    if (scope.value === "selected" && selectedSourceId === undefined) { status.textContent = "Select a source before starting research."; return; }
    const ids = scope.value === "selected" ? [selectedSourceId as string] : [];
    let body: string;
    try { body = researchRunBody(query.value, ids, 16, scope.value === "project" ? selectedProjectId : undefined); } catch (error: unknown) { status.textContent = message(error); return; }
    clearProgressTimer(); lastExecutionState = undefined;
    const active = ++serial; controller?.abort(); const local = new AbortController(); controller = local;
    if (body !== previousBody) { previousBody = body; idempotencyKey = crypto.randomUUID(); }
    submit.disabled = true; refresh.disabled = true; recover.disabled = true; result.replaceChildren(); result.hidden = true; status.textContent = "Starting the research run…";
    element.dispatchEvent(new CustomEvent("research:started", { bubbles: true }));
    void startResearchRun(body, idempotencyKey, generation, local.signal)
      .then((view) => { if (active !== serial) return; workflowId = view.workflow_instance_id; workflowGeneration = view.deployment_generation; workflowInput.value = view.workflow_instance_id; lastExecutionState = "ACTIVE"; lastEngineStatus = undefined; lastAnswerAvailability = undefined; badge.textContent = "RUNNING"; progress.textContent = "Research started. Checking progress automatically."; refresh.disabled = false; status.textContent = "Research started. Checking progress automatically."; loadHistory("manual", true); })
      .catch((error: unknown) => { if (active !== serial || (error instanceof Error && error.name === "AbortError")) return; if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) clearPrivate(); else { badge.textContent = idleBadgeText(healthReady(), researchConfigurationReady()); progress.textContent = "Research could not be started."; status.textContent = message(error); } })
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
        stop(); workflowId = undefined; workflowGeneration = undefined; previousBody = ""; idempotencyKey = "";
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
      IdentifierSchema.parse(id); stop(); workflowId = undefined; workflowGeneration = undefined; previousBody = ""; idempotencyKey = ""; result.replaceChildren(); result.hidden = true;
      selectedSourceId = id; workflowInput.value = ""; updateButtons(); selectedOption.disabled = false; scope.value = "selected"; status.textContent = context?.sourceRevisionRef ? "Selected source ready for a research run." : "Selected source loaded; refresh the Library before starting.";
    },
  });
}
