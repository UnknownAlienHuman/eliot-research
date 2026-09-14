import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import {
  readWikiProposal,
  readWikiProposalBody,
  readWikiProposals,
  type WikiProposalListView,
  type WikiProposalReadView,
  type WikiProposalSummary,
  type WikiSourceFreshness,
} from "./wiki-api.js";
import { expectedWikiHeadRevision, publishWikiProposal } from "./wiki-publish-api.js";
import { mountWikiEditForm } from "./wiki-edit-form.js";
import type { EvidenceLabel, VersionedRef } from "@eliotr/contracts";

const RISK_LABELS: Record<WikiProposalSummary["risk_class"], string> = {
  D0_MECHANICAL: "Mechanical",
  D1_LOW_RISK_ADDITIVE: "Low-risk additive",
  D2_ANALYTICAL: "Analytical",
  D3_AUTHORITY_SENSITIVE: "Authority-sensitive",
};

const EVIDENCE_LABELS: Record<EvidenceLabel, string> = {
  SOURCE_SUPPORTED: "Supported by source",
  DERIVED_INFERENCE: "Derived inference",
  HYPOTHESIS: "Hypothesis",
  CONTESTED: "Contested",
  UNRESOLVED: "Unresolved",
  EDITORIAL_RECOMMENDATION: "Editorial recommendation",
  REDACTED_DEPENDENCY: "Redacted dependency",
};
const HISTORICAL_DRAFT_LIMITATION = "This analytical research draft remains PROPOSED pending human review.";

function isOwnerEditProposal(proposal: WikiProposalReadView): boolean {
  return proposal.page.publication_metadata.protocol === "eliotr.wiki-owner-edit.v1";
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function stateLabel(state: WikiProposalSummary["state"]): string {
  return state === "PUBLISHED" ? "Published" : "Proposed";
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function codeRef(value: string): HTMLElement {
  const code = document.createElement("code");
  code.textContent = value;
  return code;
}

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return "Sign in again to view Wiki proposals.";
    if (error.status === 403) return "Wiki proposals are unavailable under the current read policy.";
    if (error.status === 404) return "This Wiki proposal is no longer available.";
    if (error.retryable) return "Wiki proposals are temporarily unavailable. Refresh to try again.";
  }
  return "Wiki proposals could not be read. Refresh to try again.";
}

function publicationErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "WIKI_PUBLICATION_INCOMPLETE") return "This proposal is not ready to publish because its evidence, coverage, or dependency checks are incomplete.";
    if (error.code === "WIKI_POLICY_DENIED") return "This proposal cannot be published under the current owner policy.";
    if (error.code === "WIKI_HEAD_CONFLICT") return "The Wiki page changed before publishing. Refresh proposals and review the current draft.";
    if (error.code === "WIKI_SETTLEMENT_UNCERTAIN") return "Publication could not be confirmed. Retry the same action or refresh Wiki proposals.";
    if (error.status === 401) return "Sign in again to publish this Wiki proposal.";
    if (error.status === 403) return "This proposal cannot be published under the current owner policy.";
    if (error.status === 404) return "This Wiki proposal is no longer available.";
    if (error.retryable) return "Wiki publication is temporarily unavailable. Retry the same action.";
  }
  return "This Wiki proposal could not be published. Refresh and try again.";
}

function shouldClearAfterPublication(error: unknown): boolean {
  return isAuthorizationLoss(error) || error instanceof ApiRequestError && error.code === "WIKI_DEPLOYMENT_CHANGED";
}

function renderReviewContext(proposal: WikiProposalReadView): HTMLElement {
  const review = document.createElement("section"); review.className = "wiki-review-context";
  const ownerEdit = isOwnerEditProposal(proposal);
  const heading = document.createElement("h4"); heading.textContent = "Review notes"; review.append(heading);
  const limitationsHeading = document.createElement("h5"); limitationsHeading.textContent = "Limitations"; review.append(limitationsHeading);
  if (proposal.page.limitations.length === 0) {
    const empty = document.createElement("p"); empty.textContent = "No limitations were recorded for this page."; review.append(empty);
  } else {
    const limitations = document.createElement("ul"); limitations.className = "wiki-review-limitations";
    proposal.page.limitations.forEach((limitation) => {
      const item = document.createElement("li");
      item.textContent = proposal.state === "PUBLISHED" && limitation === HISTORICAL_DRAFT_LIMITATION
        ? "Historical draft note: the original page was awaiting human review." : limitation;
      limitations.append(item);
    });
    review.append(limitations);
  }
  const labelsHeading = document.createElement("h5"); labelsHeading.textContent = "Statement labels"; review.append(labelsHeading);
  const labels = Object.values(proposal.page.statement_labels);
  if (labels.length === 0) {
    const empty = document.createElement("p"); empty.textContent = "No statement labels were recorded for this page."; review.append(empty);
  } else {
    const labelList = document.createElement("ul"); labelList.className = "wiki-review-labels";
    labels.forEach((label, index) => {
      const item = document.createElement("li"); item.textContent = `Statement ${index + 1}: ${EVIDENCE_LABELS[label]}`; labelList.append(item);
    });
    review.append(labelList);
  }
  const note = document.createElement("p");
  note.textContent = ownerEdit
    ? "Manual edits remain UNRESOLVED; publishing does not confirm new facts."
    : proposal.state === "PUBLISHED"
      ? "Publication did not change the meaning of unresolved or contested statements."
      : "Publishing does not change the meaning of unresolved or contested statements.";
  review.append(note);
  return review;
}

function renderSourceFreshnessNotice(freshness: WikiSourceFreshness): HTMLElement | undefined {
  if (freshness.state === "UNKNOWN") return undefined;
  const notice = document.createElement("p");
  notice.className = "wiki-source-freshness";
  notice.textContent = freshness.state === "PREVIOUS_REVISIONS"
    ? "Source updated — this page uses an earlier version; review it against the updated document."
    : "Source revisions matched the saved page when it was read.";
  return notice;
}

function appendSourceFreshnessDetails(fields: HTMLElement, freshness: WikiSourceFreshness): void {
  if (freshness.state === "UNKNOWN") return;
  const add = (label: string, value: string): void => {
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.append(codeRef(value)); fields.append(term, detail);
  };
  add("Source freshness", freshness.state);
  add("Freshness checked", freshness.checked_at ?? "not recorded");
  const term = document.createElement("dt"); term.textContent = "Changed sources";
  const detail = document.createElement("dd");
  if (freshness.changed_sources.length === 0) {
    detail.textContent = "None recorded";
  } else {
    const list = document.createElement("ul");
    freshness.changed_sources.forEach((source) => {
      const item = document.createElement("li");
      item.append(codeRef(`${source.source_id}: saved ${source.saved_revision_ref}; current ${source.head_revision_ref}`));
      list.append(item);
    });
    detail.append(list);
  }
  fields.append(term, detail);
}

export function mountWikiPanel(
  element: HTMLElement,
  deploymentGeneration: () => string | undefined,
  healthReady: () => boolean = () => false,
): (() => void) & { clearPrivate(message?: string): void; refresh(): void } {
  element.innerHTML = `<div class="wiki-panel"><div class="tool-heading"><div><span class="eyebrow">Wiki</span><h2>Saved Wiki proposals</h2></div><button type="button" class="button button--quiet" data-wiki-refresh>Refresh</button></div>
    <p class="wiki-intro">Review proposals and read saved page text.</p>
    <p class="wiki-status" role="status" aria-live="polite">Wiki proposals appear after the owner session is ready.</p>
    <section class="wiki-proposal-list" data-wiki-list aria-live="polite"></section>
    <section class="wiki-proposal-reader" data-wiki-reader hidden aria-live="polite"></section></div>`;
  const refreshButton = element.querySelector<HTMLButtonElement>("[data-wiki-refresh]");
  const status = element.querySelector<HTMLElement>(".wiki-status");
  const list = element.querySelector<HTMLElement>("[data-wiki-list]");
  const reader = element.querySelector<HTMLElement>("[data-wiki-reader]");
  if (!refreshButton || !status || !list || !reader) throw new Error("Wiki panel is incomplete");

  let serial = 0;
  let controller: AbortController | undefined;
  let disposed = false;
  let listView: WikiProposalListView | undefined;
  let listGeneration: string | undefined;
  let openedProposal: WikiProposalReadView | undefined;
  let openedBody: string | undefined;
  let publicationExpectedHeadRevision: number | undefined;
  let publicationIdempotencyKey: string | undefined;
  let editFormCleanup: ReturnType<typeof mountWikiEditForm> | undefined;

  const updateButtons = (): void => {
    const disabled = controller !== undefined || !healthReady() || !navigator.onLine;
    refreshButton.disabled = disabled;
    list.querySelectorAll<HTMLButtonElement>("[data-wiki-open]").forEach((button) => { button.disabled = disabled; });
    const publishButton = reader.querySelector<HTMLButtonElement>("[data-wiki-publish]");
    const confirmation = reader.querySelector<HTMLInputElement>("[data-wiki-publish-confirm]");
    if (publishButton !== null) {
      publishButton.disabled = disabled || openedProposal?.state !== "PROPOSED"
        || publicationExpectedHeadRevision === undefined || confirmation?.checked !== true;
    }
  };
  const cancel = (): void => {
    serial += 1;
    controller?.abort();
    controller = undefined;
  };
  const clearReader = (): void => {
    editFormCleanup?.(); editFormCleanup = undefined;
    reader.replaceChildren(); reader.hidden = true;
    openedProposal = undefined; openedBody = undefined;
    publicationExpectedHeadRevision = undefined; publicationIdempotencyKey = undefined;
  };
  const clearPrivate = (message = "Private Wiki data cleared. Refresh to read saved proposals."): void => {
    cancel(); listView = undefined; listGeneration = undefined; list.replaceChildren(); clearReader(); status.textContent = message; updateButtons();
  };

  const renderList = (view: WikiProposalListView): void => {
    list.replaceChildren();
    if (view.items.length === 0) return;
    view.items.forEach((item, index) => {
      const card = document.createElement("article"); card.className = "wiki-proposal-card";
      const heading = document.createElement("h3"); heading.textContent = item.title;
      const meta = document.createElement("p"); meta.className = "wiki-proposal-meta"; meta.textContent = `${item.page_type} · ${RISK_LABELS[item.risk_class]} · ${stateLabel(item.state)} · ${dateLabel(item.created_at)}`;
      const open = document.createElement("button"); open.type = "button"; open.className = "button button--quiet"; open.textContent = "Open proposal"; open.dataset.wikiOpen = String(index);
      const details = document.createElement("details"); details.className = "wiki-proposal-details";
      const summary = document.createElement("summary"); summary.textContent = "Technical details";
      const fields = document.createElement("dl");
      const field = (label: string, value: string): void => { const term = document.createElement("dt"); term.textContent = label; const detail = document.createElement("dd"); detail.append(codeRef(value)); fields.append(term, detail); };
      field("Proposal", refKey(item.proposal_ref)); field("Page", refKey(item.page_ref)); field("Created", item.created_at);
      details.append(summary, fields); card.append(heading, meta, open, details); list.append(card);
    });
    if (view.has_more) { const note = document.createElement("p"); note.className = "wiki-list-note"; note.textContent = "More saved proposals exist; this view shows the most recent page."; list.append(note); }
  };

  const renderProposal = (proposal: WikiProposalReadView, body: string): void => {
    openedProposal = proposal; openedBody = body;
    publicationExpectedHeadRevision = undefined; publicationIdempotencyKey = undefined;
    editFormCleanup?.(); editFormCleanup = undefined;
    reader.replaceChildren(); reader.hidden = false;
    const heading = document.createElement("div"); heading.className = "wiki-reader-heading";
    const title = document.createElement("h3"); title.textContent = proposal.page.title;
    const state = document.createElement("span"); state.textContent = stateLabel(proposal.state);
    heading.append(title, state);
    const meta = document.createElement("p"); meta.className = "wiki-proposal-meta"; meta.textContent = `${proposal.page.page_type} · ${RISK_LABELS[proposal.risk_class]} · ${dateLabel(proposal.page.created_at)}`;
    const content = document.createElement("pre"); content.className = "wiki-proposal-body"; content.textContent = body;
    const details = document.createElement("details"); details.className = "wiki-proposal-details";
    const summary = document.createElement("summary"); summary.textContent = "Technical details";
    const fields = document.createElement("dl");
    const field = (label: string, value: string): void => { const term = document.createElement("dt"); term.textContent = label; const detail = document.createElement("dd"); detail.append(codeRef(value)); fields.append(term, detail); };
    field("Proposal", refKey(proposal.proposal_ref)); field("Page", refKey(proposal.page.page_ref)); field("Scope", refKey(proposal.page.scope_snapshot_ref));
    field("Body", `${proposal.page.body_sha256} · ${body.length} characters`); field("Deployment", proposal.deployment_generation);
    appendSourceFreshnessDetails(fields, proposal.source_freshness);
    details.append(summary, fields);
    const freshnessNotice = renderSourceFreshnessNotice(proposal.source_freshness);
    reader.append(heading, meta, ...(freshnessNotice === undefined ? [] : [freshnessNotice]), content, details, renderReviewContext(proposal));
    if (proposal.state === "PROPOSED") {
      const action = document.createElement("div"); action.className = "wiki-publication-action";
      const explanation = document.createElement("p");
      const previousRevisions = proposal.source_freshness.state === "PREVIOUS_REVISIONS";
      explanation.textContent = previousRevisions
        ? "This page uses an earlier source version. Start new Research on the updated sources before publishing."
        : isOwnerEditProposal(proposal)
          ? "This manual edit remains UNRESOLVED. Publishing does not confirm new facts; review it before publishing."
          : "Review this saved draft before publishing. The server will recheck its evidence and policy.";
      action.append(explanation);
      if (!previousRevisions && proposal.page.status !== "DRAFT") {
        const note = document.createElement("p"); note.textContent = "This proposal is not a publishable draft."; action.append(note);
      } else if (!previousRevisions) {
        try {
          publicationExpectedHeadRevision = expectedWikiHeadRevision(proposal.page);
          publicationIdempotencyKey = `wiki-publication:${proposal.proposal_ref.id}`;
          const label = document.createElement("label");
          const confirmation = document.createElement("input");
          confirmation.type = "checkbox"; confirmation.dataset.wikiPublishConfirm = "true";
          confirmation.onchange = updateButtons;
          label.append(confirmation, document.createTextNode(" I have reviewed this proposal and want to publish it."));
          const publish = document.createElement("button");
          publish.type = "button"; publish.className = "button"; publish.textContent = "Publish page";
          publish.dataset.wikiPublish = "true";
          action.append(label, publish);
        } catch {
          const note = document.createElement("p");
          note.textContent = "This proposal's revision history is invalid, so it cannot be published.";
          action.append(note);
        }
      }
      reader.append(action);
    }
    if (proposal.state === "PUBLISHED") {
      if (proposal.source_freshness.state === "PREVIOUS_REVISIONS") {
        const note = document.createElement("p");
        note.className = "wiki-source-freshness";
        note.textContent = "This page uses an earlier source version. Start new Research on the updated sources before editing it.";
        reader.append(note);
      } else {
        const editHost = document.createElement("div");
        reader.append(editHost);
        editFormCleanup = mountWikiEditForm(editHost, {
          proposal,
          bodyText: body,
          deploymentGeneration,
          healthReady,
          onSaved: ({ proposal: savedProposal, bodyText: savedBody }) => {
            if (disposed || deploymentGeneration() !== savedProposal.deployment_generation) return;
            renderProposal(savedProposal, savedBody);
            status.textContent = "New draft saved. Review it before publishing.";
          },
        });
      }
    }
    updateButtons();
  };

  const publishLoadedProposal = (): void => {
    const proposal = openedProposal;
    const body = openedBody;
    const expectedHeadRevision = publicationExpectedHeadRevision;
    const idempotencyKey = publicationIdempotencyKey;
    if (proposal === undefined || body === undefined || proposal.state !== "PROPOSED" || proposal.page.status !== "DRAFT"
      || expectedHeadRevision === undefined || idempotencyKey === undefined || controller !== undefined
      || !healthReady() || !navigator.onLine) return;
    const generation = deploymentGeneration();
    if (generation === undefined || proposal.deployment_generation !== generation) { load(); return; }
    cancel(); const mine = serial; const local = new AbortController(); controller = local;
    status.textContent = "Publishing Wiki page…"; updateButtons();
    let refreshList = false;
    void (async () => {
      await publishWikiProposal(proposal.proposal_ref, proposal.page.page_ref, expectedHeadRevision, idempotencyKey, generation, local.signal);
      const readback = await readWikiProposal(proposal.proposal_ref, generation, local.signal);
      if (readback.state !== "PUBLISHED"
        || !sameRef(readback.page.page_ref, proposal.page.page_ref)
        || readback.page.body_sha256 !== proposal.page.body_sha256) {
        throw new ApiRequestError({ status: 502, code: "WIKI_RESPONSE_INVALID", message: "Published Wiki page readback is invalid" });
      }
      if (mine !== serial || disposed || deploymentGeneration() !== generation) return;
      renderProposal(readback, body); status.textContent = "Wiki page published.";
      listView = undefined; listGeneration = undefined; refreshList = true;
    })()
      .catch((error: unknown) => {
        if (mine !== serial || disposed || (error instanceof Error && error.name === "AbortError")) return;
        if (shouldClearAfterPublication(error)) {
          clearPrivate(error instanceof ApiRequestError && error.status === 403 ? "Wiki publication is unavailable under the current read policy." : "The Wiki workspace changed. Refresh to continue.");
          return;
        }
        if (error instanceof ApiRequestError && error.status === 404) clearReader();
        status.textContent = publicationErrorText(error);
      })
      .finally(() => {
        if (mine === serial && controller === local) {
          controller = undefined; updateButtons();
          if (refreshList) load();
        }
      });
  };

  const load = (): void => {
    if (disposed) return;
    const generation = deploymentGeneration();
    if (!healthReady() || !navigator.onLine || generation === undefined) { clearPrivate(!navigator.onLine ? "Offline. Private Wiki data cleared." : "Owner API is unavailable. Wiki proposals are not loaded."); return; }
    cancel(); const mine = serial; const local = new AbortController(); controller = local; clearReader(); status.textContent = "Reading saved Wiki proposals…"; updateButtons();
    void readWikiProposals(generation, local.signal)
      .then((view) => {
        if (mine !== serial || disposed || deploymentGeneration() !== generation) return;
        listView = view; listGeneration = view.deployment_generation; renderList(view); status.textContent = view.items.length === 0 ? "No saved Wiki proposals." : `${view.items.length} saved Wiki proposal${view.items.length === 1 ? "" : "s"} available.`;
      })
      .catch((error: unknown) => {
        if (mine !== serial || disposed || (error instanceof Error && error.name === "AbortError")) return;
        if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 403 || error.status === 409)) { clearPrivate(error.status === 403 ? "Wiki proposals are unavailable under the current read policy." : "The Wiki workspace changed. Refresh to read saved proposals."); return; }
        status.textContent = errorText(error);
      })
      .finally(() => { if (mine === serial && controller === local) { controller = undefined; updateButtons(); } });
  };

  const openProposal = (item: WikiProposalSummary): void => {
    if (disposed || controller !== undefined || !healthReady() || !navigator.onLine) return;
    const generation = deploymentGeneration();
    if (generation === undefined || listGeneration !== generation) { load(); return; }
    cancel(); const mine = serial; const local = new AbortController(); controller = local; clearReader(); reader.hidden = false; status.textContent = "Opening Wiki proposal…"; updateButtons();
    void (async () => {
      const proposal = await readWikiProposal(item.proposal_ref, generation, local.signal);
      if (!sameRef(proposal.proposal_ref, item.proposal_ref) || !sameRef(proposal.page.page_ref, item.page_ref) || proposal.risk_class !== item.risk_class || proposal.state !== item.state) throw new ApiRequestError({ status: 502, code: "WIKI_RESPONSE_INVALID", message: "Wiki proposal identity changed" });
      const body = await readWikiProposalBody(proposal.proposal_ref, proposal.page.page_ref, proposal.page.body_sha256, generation, local.signal);
      if (body.deployment_generation !== generation) throw new ApiRequestError({ status: 409, code: "WIKI_DEPLOYMENT_CHANGED", message: "The application changed; refresh Wiki proposals", retryable: true });
      if (mine !== serial || disposed || deploymentGeneration() !== generation) return;
      renderProposal(proposal, body.text); status.textContent = "Wiki proposal opened.";
    })()
      .catch((error: unknown) => {
        if (mine !== serial || disposed || (error instanceof Error && error.name === "AbortError")) return;
        if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 403 || error.status === 409)) { clearPrivate(error.status === 403 ? "Wiki proposal is unavailable under the current read policy." : "The Wiki workspace changed. Refresh to read saved proposals."); return; }
        clearReader(); status.textContent = errorText(error);
      })
      .finally(() => { if (mine === serial && controller === local) { controller = undefined; updateButtons(); } });
  };

  refreshButton.onclick = load;
  list.onclick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-wiki-open]");
    const index = button === null ? NaN : Number(button.dataset.wikiOpen);
    const item = Number.isSafeInteger(index) ? listView?.items[index] : undefined;
    if (item !== undefined) openProposal(item);
  };
  reader.onclick = (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest<HTMLButtonElement>("[data-wiki-publish]") === null) return;
    publishLoadedProposal();
  };
  const offline = (): void => clearPrivate("Offline. Private Wiki data cleared.");
  const denied = (): void => clearPrivate("Authorization changed. Sign in again to view Wiki proposals.");
  const onProposalCreated = (): void => { if (!disposed) { listView = undefined; listGeneration = undefined; load(); } };
  window.addEventListener("offline", offline); window.addEventListener("eliotr:authorization-cleared", denied); window.addEventListener("eliotr:wiki-proposal-created", onProposalCreated);
  const refresh = (): void => {
    const generation = deploymentGeneration();
    if (!healthReady() || !navigator.onLine || generation === undefined) { updateButtons(); return; }
    if (listView !== undefined && listGeneration === generation) { updateButtons(); return; }
    load();
  };
  updateButtons();
  const cleanup = (): void => { disposed = true; cancel(); editFormCleanup?.(); editFormCleanup = undefined; refreshButton.onclick = null; list.onclick = null; reader.onclick = null; window.removeEventListener("offline", offline); window.removeEventListener("eliotr:authorization-cleared", denied); window.removeEventListener("eliotr:wiki-proposal-created", onProposalCreated); element.replaceChildren(); };
  return Object.assign(cleanup, { clearPrivate, refresh });
}
