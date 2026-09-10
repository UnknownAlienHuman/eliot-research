import { IdentifierSchema } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { escapeHtml } from "./html.js";
import { researchRunBody, readResearchRunStatus, startResearchRun, type ResearchRunStatusView } from "./research-run-api.js";
import type { LibrarySelectionContext } from "./library-readiness-api.js";

function message(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) return "This research run is no longer available for the current session.";
    if (error.status === 409) return "The Research run belongs to another deployment or its authority changed. Refresh the workspace.";
    if (error.retryable) return "The Research service is unavailable. Refresh to try again.";
    return "The Research run could not be read. Check the query and session.";
  }
  return "The Research run could not be read. Check the query and session.";
}

function statusText(view: ResearchRunStatusView): string {
  switch (view.execution_state) {
    case "ACTIVE": return "Research is still processing. Refresh status to check again.";
    case "CANCELLED": return "Research was cancelled. Answer unavailable.";
    case "ENGINE_COMPLETED": return "Processing finished. No answer has been generated.";
  }
}

export function mountResearchRunPanel(
  element: HTMLElement,
  deploymentGeneration: () => string | undefined,
  healthReady: () => boolean = () => false,
): (() => void) & { clearPrivate(): void; selectSource(id: string, context?: LibrarySelectionContext): void } {
  element.innerHTML = `<div class="workflow-head"><div><span class="eyebrow">Research run</span><h2>Prepare a research run</h2></div><span class="workflow-badge" data-run-badge>${healthReady() ? "READY" : "WAITING"}</span></div>
    <p class="workflow-copy">Start the owner-bound research workflow, then refresh its persisted status when you choose. A completed workflow does not imply that an answer is available.</p>
    <form><label>Question<input name="query" maxlength="4096" autocomplete="off" required placeholder="Ask a research question"></label>
    <label>Scope<select name="scope"><option value="library">Entire authorized Library</option><option value="selected" disabled>Selected source</option></select></label>
    <div class="workflow-actions"><button type="submit" class="button">Start research</button><button type="button" class="button button--quiet" data-refresh disabled>Refresh status</button></div></form>
    <div class="workflow-recovery"><label>Known workflow handle<input data-workflow-id maxlength="128" autocomplete="off" placeholder="Paste a known workflow ID"></label><button type="button" class="button button--quiet" data-recover>Load status</button></div>
    <p class="workflow-status" role="status" aria-live="polite">${healthReady() ? "Ready when the current owner session is available." : "Waiting for the current owner session."}</p>
    <section data-run-result hidden></section>`;
  const form = element.querySelector<HTMLFormElement>("form");
  const query = element.querySelector<HTMLInputElement>('input[name="query"]');
  const scope = element.querySelector<HTMLSelectElement>('select[name="scope"]');
  const selectedOption = scope?.querySelector<HTMLOptionElement>('option[value="selected"]');
  const submit = element.querySelector<HTMLButtonElement>('button[type="submit"]');
  const refresh = element.querySelector<HTMLButtonElement>("[data-refresh]");
  const workflowInput = element.querySelector<HTMLInputElement>("[data-workflow-id]");
  const recover = element.querySelector<HTMLButtonElement>("[data-recover]");
  const status = element.querySelector<HTMLElement>('[role="status"]');
  const result = element.querySelector<HTMLElement>("[data-run-result]");
  if (!form || !query || !scope || !selectedOption || !submit || !refresh || !workflowInput || !recover || !status || !result) throw new Error("Research run panel is incomplete");

  let serial = 0;
  let controller: AbortController | undefined;
  let workflowId: string | undefined;
  let workflowGeneration: string | undefined;
  let selectedSourceId: string | undefined;
  let previousBody = "";
  let idempotencyKey = "";

  const stop = (): void => { serial += 1; controller?.abort(); controller = undefined; submit.disabled = false; refresh.disabled = workflowId === undefined; recover.disabled = false; };
  const clearPrivate = (): void => {
    stop(); workflowId = undefined; workflowGeneration = undefined; selectedSourceId = undefined; previousBody = ""; idempotencyKey = "";
    workflowInput.value = ""; result.replaceChildren(); result.hidden = true; query.value = ""; scope.value = "library"; selectedOption.disabled = true;
    refresh.disabled = true; status.textContent = "Private research state cleared. Reconnect before starting or loading a run.";
  };
  const renderStatus = (view: ResearchRunStatusView): void => {
    const text = statusText(view);
    result.hidden = false; result.innerHTML = `<p><strong>${text}</strong></p><p>Run <code>${escapeHtml(view.workflow_instance_id)}</code> · investigation <code>${escapeHtml(view.investigation_ref.id)}</code></p>`;
    status.textContent = text; refresh.disabled = false;
  };
  const readStatus = (): void => {
    const id = workflowInput.value.trim();
    if (id.length === 0) { status.textContent = "Enter a known workflow handle first."; return; }
    const active = ++serial; controller?.abort(); const local = new AbortController(); controller = local;
    submit.disabled = true; recover.disabled = true; refresh.disabled = true; status.textContent = "Reading persisted research status…";
    const expectedGeneration = id === workflowId ? (workflowGeneration ?? deploymentGeneration()) : deploymentGeneration();
    void readResearchRunStatus(id, expectedGeneration, local.signal)
      .then((view) => { if (active !== serial) return; workflowId = view.workflow_instance_id; workflowGeneration = view.deployment_generation; workflowInput.value = view.workflow_instance_id; renderStatus(view); })
      .catch((error: unknown) => { if (active !== serial || (error instanceof Error && error.name === "AbortError")) return; if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) clearPrivate(); else status.textContent = message(error); })
      .finally(() => { if (active === serial) { controller = undefined; submit.disabled = false; recover.disabled = false; refresh.disabled = workflowId === undefined; } });
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!healthReady() || !navigator.onLine) { status.textContent = "Owner workspace is unavailable. Reconnect before starting research."; return; }
    const ids = scope.value === "selected" && selectedSourceId ? [selectedSourceId] : [];
    let body: string;
    try { body = researchRunBody(query.value, ids); } catch (error: unknown) { status.textContent = message(error); return; }
    const active = ++serial; controller?.abort(); const local = new AbortController(); controller = local;
    if (body !== previousBody) { previousBody = body; idempotencyKey = crypto.randomUUID(); }
    submit.disabled = true; refresh.disabled = true; recover.disabled = true; result.replaceChildren(); result.hidden = true; status.textContent = "Starting the research run…";
    element.dispatchEvent(new CustomEvent("research:started", { bubbles: true }));
    void startResearchRun(body, idempotencyKey, deploymentGeneration(), local.signal)
      .then((view) => { if (active !== serial) return; workflowId = view.workflow_instance_id; workflowGeneration = view.deployment_generation; workflowInput.value = view.workflow_instance_id; refresh.disabled = false; status.textContent = "Research started. Refresh status when you want to read the persisted run."; })
      .catch((error: unknown) => { if (active !== serial || (error instanceof Error && error.name === "AbortError")) return; if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.code === "RESEARCH_RUN_DEPLOYMENT_CHANGED")) clearPrivate(); else status.textContent = message(error); })
      .finally(() => { if (active === serial) { controller = undefined; submit.disabled = false; recover.disabled = false; refresh.disabled = workflowId === undefined; } });
  };
  refresh.onclick = readStatus;
  recover.onclick = readStatus;
  const cleanup = (): void => { stop(); };
  return Object.assign(cleanup, {
    clearPrivate,
    selectSource(id: string, context?: LibrarySelectionContext): void {
      IdentifierSchema.parse(id); stop(); workflowId = undefined; workflowGeneration = undefined; previousBody = ""; idempotencyKey = ""; result.replaceChildren(); result.hidden = true;
      selectedSourceId = id; workflowInput.value = ""; refresh.disabled = true; selectedOption.disabled = false; scope.value = "selected"; status.textContent = context?.sourceRevisionRef ? "Selected source ready for a research run." : "Selected source loaded; refresh the Library before starting.";
    },
  });
}
