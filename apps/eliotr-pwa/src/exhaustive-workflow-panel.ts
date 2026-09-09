import { IdentifierSchema } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import {
  cancelExhaustiveWorkflow, exhaustiveQueryBody, launchExhaustiveWorkflow, pollExhaustiveWorkflow,
  readExhaustiveWorkflow, type ExhaustiveJobView, type ExhaustiveWorkflowView,
} from "./exhaustive-workflow-api.js";

function message(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) return "This scan is no longer available for the current session.";
    if (error.status === 409) return "The selected sources changed before the scan could finish. Start again to use the current selection.";
    if (error.retryable) return "The scan could not reach the research service. Check again with the same inputs.";
    return "The scan could not be started. Check the query and try again.";
  }
  return "The scan could not be reconciled. Check again with the same inputs.";
}

function statusLabel(status: ExhaustiveWorkflowView["workflow_status"]): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Scanning";
    case "paused": case "waiting": case "waitingForPause": return "Waiting";
    case "complete": return "Complete";
    case "errored": return "Stopped with an error";
    case "terminated": return "Cancelled";
    default: return "Status unavailable";
  }
}

function jobDetail(job: ExhaustiveJobView | undefined): string {
  if (job === undefined) return "Progress will appear here as the scan runs.";
  if (job.status === "COMPLETE") {
    return `${job.total_scanned_sections} section${job.total_scanned_sections === 1 ? "" : "s"} scanned · ${job.total_matches} match${job.total_matches === 1 ? "" : "es"}.`;
  }
  return `Read ${job.settled_shards} of ${job.denominator_shards} batches · coverage is still incomplete.`;
}

function terminal(view: ExhaustiveWorkflowView): boolean {
  return ["complete", "errored", "terminated", "unknown"].includes(view.workflow_status);
}

export function mountExhaustiveWorkflowPanel(
  element: HTMLElement,
  deploymentGeneration: () => string | undefined,
  healthReady: () => boolean = () => false,
): (() => void) & { clearPrivate(): void; selectSource(id: string): void } {
  element.innerHTML = `<div class="workflow-head"><div><span class="eyebrow">Exhaustive scan</span><h2>Search the full selected scope</h2></div><span class="workflow-badge" data-workflow-badge>${healthReady() ? "READY" : "WAITING"}</span></div>
    <p class="workflow-copy">Run an exact scan across every section in the selected scope. A complete result confirms the chosen scope was searched; an interrupted scan stays visibly incomplete.</p>
    <form><label>Query<input name="query" maxlength="8192" autocomplete="off" required placeholder="A phrase to find exactly"></label>
    <label>Scope<select name="scope"><option value="library">Entire authorized Library</option><option value="selected" disabled>Choose a source from Library</option></select></label>
    <div class="workflow-actions"><button type="submit" class="button">Start full scan</button><button type="button" class="button button--quiet" data-cancel disabled>Cancel on server</button><button type="button" class="button button--quiet" data-refresh disabled>Check status</button></div></form>
    <p class="workflow-status" role="status" aria-live="polite">Ready when the current session is available.</p>
    <div class="workflow-progress" data-progress hidden><div class="workflow-progress-bar" data-progress-bar></div></div>
    <p class="workflow-detail" data-detail></p>`;
  const form = element.querySelector<HTMLFormElement>("form");
  const query = element.querySelector<HTMLInputElement>('input[name="query"]');
  const scope = element.querySelector<HTMLSelectElement>('select[name="scope"]');
  const selectedScopeOption = scope?.querySelector<HTMLOptionElement>('option[value="selected"]');
  const submit = element.querySelector<HTMLButtonElement>('button[type="submit"]');
  const cancel = element.querySelector<HTMLButtonElement>("[data-cancel]");
  const refresh = element.querySelector<HTMLButtonElement>("[data-refresh]");
  const status = element.querySelector<HTMLElement>("[data-workflow-badge]");
  const statusText = element.querySelector<HTMLElement>(".workflow-status");
  const detail = element.querySelector<HTMLElement>("[data-detail]");
  const progress = element.querySelector<HTMLElement>("[data-progress]");
  const progressBar = element.querySelector<HTMLElement>("[data-progress-bar]");
  if (!form || !query || !scope || !selectedScopeOption || !submit || !cancel || !refresh || !status || !statusText || !detail || !progress || !progressBar) {
    throw new Error("Exhaustive workflow panel is incomplete");
  }

  let serial = 0;
  let controller: AbortController | undefined;
  let workflowId: string | undefined;
  let workflowGeneration: string | undefined;
  let busy = false;
  let cancelling = false;
  let selectedSourceId: string | undefined;
  let previousBody = "";
  let idempotencyKey = "";

  const buttons = (): void => {
    submit.disabled = !healthReady() || busy || (workflowId !== undefined && !terminalState);
    cancel.disabled = workflowId === undefined || terminalState || cancelling;
    refresh.disabled = workflowId === undefined || busy;
    query.disabled = busy || (workflowId !== undefined && !terminalState);
    scope.disabled = busy || (workflowId !== undefined && !terminalState);
  };
  let terminalState = false;
  const refreshHealthState = (): void => {
    if (!busy && workflowId === undefined) status.textContent = healthReady() ? "READY" : "WAITING";
    buttons();
  };

  const stopWatching = (text: string): void => {
    serial += 1;
    controller?.abort();
    controller = undefined;
    busy = false;
    statusText.textContent = text;
    buttons();
  };

  const render = (view: ExhaustiveWorkflowView): void => {
    terminalState = terminal(view);
    const complete = view.workflow_status === "complete" && view.job?.status === "COMPLETE";
    status.textContent = (complete ? "Complete" : view.workflow_status === "complete" ? "INCOMPLETE" : statusLabel(view.workflow_status)).toUpperCase();
    detail.textContent = jobDetail(view.job);
    if (view.job?.status === "UNFINISHED") {
      progress.hidden = false;
      progressBar.style.width = `${Math.min(100, Math.round((view.job.settled_shards / view.job.denominator_shards) * 100))}%`;
    } else if (view.job?.status === "COMPLETE") {
      progress.hidden = false; progressBar.style.width = "100%";
    } else {
      progress.hidden = true; progressBar.style.width = "0%";
    }
    if (view.workflow_status === "complete" && view.job?.status === "COMPLETE") {
      statusText.textContent = "Complete coverage recorded for the selected sources.";
      element.dispatchEvent(new CustomEvent("exhaustive:completed", { bubbles: true, detail: { matches: view.job.total_matches, sections: view.job.total_scanned_sections } }));
    } else if (view.workflow_status === "complete") {
      statusText.textContent = "Finished, but the current access could not confirm this result. Check status again.";
    } else if (view.workflow_status === "errored") {
      statusText.textContent = "The scan ended with an error before complete coverage was earned.";
    } else if (view.workflow_status === "terminated") {
      statusText.textContent = "The scan was cancelled on the server.";
    } else if (view.workflow_status === "unknown") {
      statusText.textContent = "The server returned an unknown workflow state. No further polling was attempted.";
    } else {
      statusText.textContent = "Working through the selected sources…";
    }
    buttons();
  };

  const reconcile = async (view: ExhaustiveWorkflowView, active: number, local: AbortController, generation: string | undefined): Promise<void> => {
    render(view);
    if (terminal(view) || active !== serial) return;
    const settled = await pollExhaustiveWorkflow(view.workflow_instance_id, generation, local.signal);
    if (active === serial) {
      render(settled);
      if (!terminal(settled)) statusText.textContent = "Progress check paused. Check again when the scan has had time to run.";
    }
  };

  const launch = (): void => {
    if (busy || (workflowId !== undefined && !terminalState)) return;
    if (!navigator.onLine) { statusText.textContent = "Offline. No scan started; private results are not cached."; return; }
    let body: string;
    try {
      body = exhaustiveQueryBody(query.value, scope.value === "selected" && selectedSourceId ? [selectedSourceId] : []);
    } catch (error) { statusText.textContent = message(error); return; }
    const active = ++serial;
    const generation = deploymentGeneration();
    const local = new AbortController(); controller = local; busy = true; workflowId = undefined; workflowGeneration = generation; terminalState = false; buttons();
    element.dispatchEvent(new CustomEvent("exhaustive:started", { bubbles: true }));
    status.textContent = "STARTING"; statusText.textContent = "Preparing the selected sources…"; detail.textContent = "Progress will be read from the server as it becomes available.";
    if (body !== previousBody) { previousBody = body; idempotencyKey = crypto.randomUUID(); }
    void launchExhaustiveWorkflow(body, idempotencyKey, generation, local.signal)
      .then((view) => { if (active === serial) { workflowId = view.workflow_instance_id; workflowGeneration = view.deployment_generation; return reconcile(view, active, local, workflowGeneration); } return Promise.resolve(); })
      .catch((error: unknown) => { if (active === serial && !(error instanceof Error && error.name === "AbortError")) { if (error instanceof ApiRequestError && error.code === "API_GENERATION_MISMATCH") clearPrivate(); else statusText.textContent = message(error); } })
      .finally(() => { if (active === serial) { busy = false; controller = undefined; buttons(); } });
  };

  form.onsubmit = (event) => { event.preventDefault(); launch(); };
  cancel.onclick = () => {
    const id = workflowId;
    if (id === undefined) { stopWatching("Launch watch stopped. Recheck the same inputs to reconcile the server state."); return; }
    const active = ++serial; controller?.abort(); busy = true; cancelling = true; buttons(); statusText.textContent = "Cancelling scan…";
    const local = new AbortController(); controller = local;
    void cancelExhaustiveWorkflow(id, workflowGeneration, local.signal)
      .then((view) => { if (active === serial) render(view); })
      .catch((error: unknown) => { if (active === serial) { if (error instanceof ApiRequestError && error.code === "API_GENERATION_MISMATCH") clearPrivate(); else statusText.textContent = message(error); } })
      .finally(() => { if (active === serial) { busy = false; cancelling = false; controller = undefined; buttons(); } });
  };
  refresh.onclick = () => {
    const id = workflowId;
    if (id === undefined || busy || !navigator.onLine) return;
    const active = ++serial; const local = new AbortController(); controller = local; busy = true; buttons(); statusText.textContent = "Checking latest progress…";
    void readExhaustiveWorkflow(id, workflowGeneration, local.signal)
      .then((view) => { if (active === serial) return reconcile(view, active, local, workflowGeneration); return Promise.resolve(); })
      .catch((error: unknown) => { if (active === serial) { if (error instanceof ApiRequestError && error.code === "API_GENERATION_MISMATCH") clearPrivate(); else statusText.textContent = message(error); } })
      .finally(() => { if (active === serial) { busy = false; controller = undefined; buttons(); } });
  };

  const clearPrivate = (): void => {
    serial += 1; controller?.abort(); controller = undefined; busy = false; cancelling = false; workflowId = undefined; workflowGeneration = undefined; terminalState = false; previousBody = ""; idempotencyKey = ""; selectedSourceId = undefined;
    status.textContent = healthReady() ? "READY" : "WAITING"; statusText.textContent = "Private scan state cleared. Reconnect before starting again."; detail.textContent = ""; progress.hidden = true; progressBar.style.width = "0%"; query.value = ""; scope.value = "library"; selectedScopeOption.disabled = true; buttons();
  };
  window.addEventListener("eliotr:authorization-cleared", clearPrivate);
  window.addEventListener("offline", clearPrivate);
  window.addEventListener("pagehide", clearPrivate);
  window.addEventListener("eliotr:health-updated", refreshHealthState);
  scope.onchange = () => { if (scope.value === "selected" && selectedSourceId === undefined) scope.value = "library"; };
  buttons();
  return Object.assign(() => {
    clearPrivate(); window.removeEventListener("eliotr:authorization-cleared", clearPrivate); window.removeEventListener("offline", clearPrivate); window.removeEventListener("pagehide", clearPrivate); window.removeEventListener("eliotr:health-updated", refreshHealthState);
  }, { clearPrivate, selectSource(id: string): void {
    if (!IdentifierSchema.safeParse(id).success) return;
    selectedSourceId = id; selectedScopeOption.disabled = false; scope.value = "selected";
  } });
}
