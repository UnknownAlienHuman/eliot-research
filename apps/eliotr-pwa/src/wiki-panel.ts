import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import {
  readWikiProposal,
  readWikiProposalBody,
  readWikiProposals,
  type WikiProposalListView,
  type WikiProposalReadView,
  type WikiProposalSummary,
} from "./wiki-api.js";
import type { VersionedRef } from "@eliotr/contracts";

const RISK_LABELS: Record<WikiProposalSummary["risk_class"], string> = {
  D0_MECHANICAL: "Mechanical",
  D1_LOW_RISK_ADDITIVE: "Low-risk additive",
  D2_ANALYTICAL: "Analytical",
  D3_AUTHORITY_SENSITIVE: "Authority-sensitive",
};

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

  const updateButtons = (): void => {
    const disabled = controller !== undefined || !healthReady() || !navigator.onLine;
    refreshButton.disabled = disabled;
    list.querySelectorAll<HTMLButtonElement>("[data-wiki-open]").forEach((button) => { button.disabled = disabled; });
  };
  const cancel = (): void => {
    serial += 1;
    controller?.abort();
    controller = undefined;
  };
  const clearReader = (): void => { reader.replaceChildren(); reader.hidden = true; };
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
    details.append(summary, fields); reader.append(heading, meta, content, details);
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
  const cleanup = (): void => { disposed = true; cancel(); refreshButton.onclick = null; list.onclick = null; window.removeEventListener("offline", offline); window.removeEventListener("eliotr:authorization-cleared", denied); window.removeEventListener("eliotr:wiki-proposal-created", onProposalCreated); element.replaceChildren(); };
  return Object.assign(cleanup, { clearPrivate, refresh });
}
