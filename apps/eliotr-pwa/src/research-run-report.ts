import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import { readReauthorizedResearchArtifactSection, type ResearchArtifactSectionCitationAuditClaim, type ResearchSourceFreshness } from "./research-run-api.js";
import { readReauthorizedResearchArtifactSectionCitations } from "./research-run-reauthorization-api.js";
import { downloadResearchDraftMarkdown, type ResearchMarkdownSection } from "./research-markdown-download.js";
import { createWikiProposalFromRun } from "./wiki-proposal-create-api.js";
import type { ArtifactRevision } from "@eliotr/contracts";
import { AUDIT_DISPOSITION_LABELS, message, wikiProposalErrorText, auditStatusText, decodeSectionBody, codeRef, citationRefKey, renderResearchSourceFreshnessNotice, createResearchReportHeader } from "./research-run-view.js";

export type ReportRenderOptions = { readonly renderSerial: number; readonly deploymentGeneration: string; readonly historical: boolean; readonly workflowInstanceId?: string; readonly investigationRef?: string; readonly authorizationScopeSnapshotRef?: { readonly id: string; readonly revision: number }; readonly sourceFreshness?: ResearchSourceFreshness };

interface ReportHooks {
  readonly element: HTMLElement;
  readonly result: HTMLElement;
  readonly status: HTMLElement;
  isCurrent(serial: number): boolean;
  busy(): boolean;
  connectionFailed(error: unknown): boolean;
  disposed(): boolean;
  generation(): string | undefined;
  setController(controller: AbortController): void;
  clearPrivate(notice?: string): void;
  setActionsDisabled(disabled: boolean): void;
  finishAction(controller: AbortController, serial: number): void;
}

export function renderResearchArtifactReport(artifact: ArtifactRevision, options: ReportRenderOptions, hooks: ReportHooks): void {
  const { element, result, status } = hooks;
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
      if (!hooks.isCurrent(options.renderSerial) || hooks.busy() || hooks.disposed()) return;
      const generation = hooks.generation();
      if (generation === undefined || generation !== options.deploymentGeneration) {
        hooks.clearPrivate("The Research workspace changed. Refresh before creating a Wiki draft.");
        return;
      }
      const local = new AbortController();
      hooks.setController(local);
      hooks.setActionsDisabled(true);
      wikiDraftStatus.hidden = false;
      wikiDraftStatus.textContent = "Saving this report as a Wiki draft…";
      status.textContent = "Saving this report as a Wiki draft…";
      void createWikiProposalFromRun(capturedWorkflowInstanceId, idempotencyKey, generation, local.signal)
        .then(() => {
          if (!hooks.isCurrent(options.renderSerial) || hooks.disposed() || hooks.generation() !== options.deploymentGeneration) return;
          createWikiDraft.disabled = true;
          createWikiDraft.dataset.reportActionUnavailable = "true";
          wikiDraftStatus.textContent = "Saved as a Wiki draft. Open Wiki to review it.";
          status.textContent = "Wiki draft saved.";
          const openWiki = document.createElement("button");
          openWiki.type = "button";
          openWiki.className = "button button--quiet";
          openWiki.textContent = "Open Wiki";
          openWiki.onclick = () => { if (!hooks.disposed() && hooks.isCurrent(options.renderSerial)) window.location.hash = "#wiki-card"; };
          reportActions.append(openWiki);
          window.dispatchEvent(new Event("eliotr:wiki-proposal-created"));
        })
        .catch((error: unknown) => {
          if (!hooks.isCurrent(options.renderSerial) || hooks.disposed() || local.signal.aborted) return;
          if (hooks.connectionFailed(error)) return;
          if (hooks.generation() !== options.deploymentGeneration) {
            hooks.clearPrivate("The Research workspace changed. Refresh before creating a Wiki draft.");
            return;
          }
          if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.code === "WIKI_DEPLOYMENT_CHANGED" || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) {
            hooks.clearPrivate(error.code === "WIKI_DEPLOYMENT_CHANGED" || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED" ? "The Research workspace changed. Refresh before creating a Wiki draft." : "Authorization changed. Sign in again before creating a Wiki draft.");
            return;
          }
          wikiDraftStatus.hidden = false;
          wikiDraftStatus.textContent = wikiProposalErrorText(error);
          status.textContent = "Wiki draft could not be saved.";
        })
        .finally(() => hooks.finishAction(local, options.renderSerial));
    };
  }
  download.onclick = () => {
    if (!hooks.isCurrent(options.renderSerial) || hooks.busy()) return;
    const local = new AbortController(); hooks.setController(local); hooks.setActionsDisabled(true); status.textContent = "Preparing Markdown download…";
    void (async () => {
      const sections: ResearchMarkdownSection[] = [];
      for (const section of artifact.sections) {
        if (!hooks.isCurrent(options.renderSerial) || hooks.generation() !== options.deploymentGeneration) return;
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
      if (!hooks.isCurrent(options.renderSerial) || hooks.generation() !== options.deploymentGeneration) return;
      downloadResearchDraftMarkdown(citationRefKey(artifact.artifact_ref), artifact.created_at, sections);
      status.textContent = "Research draft downloaded as Markdown.";
    })()
      .catch((error: unknown) => {
        if (!hooks.isCurrent(options.renderSerial) || (error instanceof Error && error.name === "AbortError")) return;
        if (hooks.connectionFailed(error)) return;
        if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 409 || error.status === 410)) { hooks.clearPrivate(); return; }
        status.textContent = `Research draft could not be downloaded. ${message(error)}`;
      })
      .finally(() => hooks.finishAction(local, options.renderSerial));
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
      if (!hooks.isCurrent(options.renderSerial) || hooks.busy()) return;
      const local = new AbortController(); hooks.setController(local); hooks.setActionsDisabled(true); status.textContent = "Reading report section…";
      const read = readReauthorizedResearchArtifactSection(artifact.artifact_ref, section.section_ref, options.deploymentGeneration, local.signal);
      void read
        .then((readback) => {
          if (!hooks.isCurrent(options.renderSerial) || hooks.generation() !== options.deploymentGeneration) return;
          if (readback.body_object_ref !== section.body_object_ref || readback.body_sha256 !== section.body_sha256) throw new ApiRequestError({ status: 502, code: "RESEARCH_ARTIFACT_SECTION_INVALID", message: "The report section changed during reauthorization" });
          const body = document.createElement("pre"); body.className = "research-section-body"; body.textContent = decodeSectionBody(readback.bytes);
          item.querySelector(".research-section-body")?.remove(); item.append(body); status.textContent = "Report section opened.";
        })
        .catch((error: unknown) => {
          if (!hooks.isCurrent(options.renderSerial) || (error instanceof Error && error.name === "AbortError")) return;
          if (hooks.connectionFailed(error)) return;
          if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 409 || error.status === 410)) { hooks.clearPrivate(); return; }
          if (error instanceof ApiRequestError && error.status === 403) item.querySelector(".research-section-body")?.remove();
          const failure = document.createElement("p"); failure.className = "research-section-error"; failure.textContent = message(error); item.querySelector(".research-section-error")?.remove(); item.append(failure);
          status.textContent = "The report section could not be opened.";
        })
        .finally(() => hooks.finishAction(local, options.renderSerial));
    };
    const sources = document.createElement("button"); sources.type = "button"; sources.className = "button button--quiet"; sources.textContent = "Open sources"; sources.dataset.openSources = String(ordinal);
    sources.onclick = () => {
      if (!hooks.isCurrent(options.renderSerial) || hooks.busy()) return;
      const local = new AbortController(); hooks.setController(local); hooks.setActionsDisabled(true); status.textContent = "Reading cited sources…";
      item.querySelector(".research-citations")?.remove(); item.querySelector(".research-citation-error")?.remove();
      const read = readReauthorizedResearchArtifactSectionCitations(artifact.artifact_ref, section.section_ref, options.deploymentGeneration, local.signal, section.verification_receipt_ref);
      void read
        .then((citations) => {
          if (!hooks.isCurrent(options.renderSerial)) return;
          const list = document.createElement("div"); list.className = "research-citations";
          const state = document.createElement("p"); state.className = "research-citation-state";
          state.textContent = citations.semantic_verification === "EXECUTED"
            ? auditStatusText(citations.audit.claims)
            : options.historical ? "Saved citations were reauthorized for this session; no claim check is recorded." : "Draft claims have not been checked. Opening a source checks its current bytes.";
          list.append(state); const aliases = citations.cited_evidence;
          const citationByRef = new Map(aliases.map((citation) => [citationRefKey(citation.original_handle_ref), citation]));
          const citationScope = citations.authorization_scope_snapshot_ref;
          const selectCitation = (citation: typeof aliases[number]): void => {
            if (!hooks.isCurrent(options.renderSerial) || hooks.busy()) return;
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
              const button = document.createElement("button"); button.type = "button"; button.className = "button button--quiet"; button.textContent = `Open source ${citationOrdinal + 1}`; button.dataset.openCitation = String(citationOrdinal); button.disabled = hooks.busy();
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
          if (!hooks.isCurrent(options.renderSerial) || (error instanceof Error && error.name === "AbortError")) return;
          if (hooks.connectionFailed(error)) return;
          if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 409 || error.status === 410)) { hooks.clearPrivate(); return; }
          if (error instanceof ApiRequestError && error.status === 403) item.querySelector(".research-citations")?.remove();
          const failure = document.createElement("p"); failure.className = "research-citation-error"; failure.textContent = message(error); item.querySelector(".research-citation-error")?.remove(); item.append(failure);
          status.textContent = "Cited sources could not be read.";
        })
        .finally(() => hooks.finishAction(local, options.renderSerial));
    };
    const actions = document.createElement("div"); actions.className = "research-report-actions"; actions.append(open, sources);
    item.append(sectionHeading, sectionTechnical, actions); sections.append(item);
  });
  result.append(sections);
}
