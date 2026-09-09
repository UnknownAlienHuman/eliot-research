import { IdentifierSchema } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import {
  cancelExhaustiveWorkflow, exhaustiveQueryBody, launchExhaustiveWorkflow, pollExhaustiveWorkflow,
  listExhaustiveWorkflows, readExhaustiveWorkflow, type ExhaustiveJobView, type ExhaustiveWorkflowPage,
  type ExhaustiveWorkflowSummary, type ExhaustiveWorkflowView,
} from "./exhaustive-workflow-api.js";

export const MAX_RECOVERY_ITEMS = 100;

export interface RecoveryPageMerge {
  items: Map<string, ExhaustiveWorkflowSummary>;
  nextCursor: string | undefined;
  added: number;
  capped: boolean;
}

export function mergeRecoveryPage(
  existing: ReadonlyMap<string, ExhaustiveWorkflowSummary>,
  page: ExhaustiveWorkflowPage,
  append: boolean,
  maxItems = MAX_RECOVERY_ITEMS,
): RecoveryPageMerge {
  const items = append ? new Map(existing) : new Map<string, ExhaustiveWorkflowSummary>();
  let added = 0;
  for (const item of page.items) {
    if (items.has(item.workflow_instance_id)) continue;
    if (items.size >= maxItems) break;
    items.set(item.workflow_instance_id, item);
    added += 1;
  }
  const capped = items.size >= maxItems;
  return { items, added, capped, nextCursor: capped ? undefined : page.next_cursor };
}

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
    <p class="workflow-detail" data-detail></p>
    <section class="workflow-recovery" aria-label="Recent scans">
      <div class="workflow-recovery-head"><div><span class="eyebrow">Recent scans</span><h3>Pick up a recent scan</h3></div><button type="button" class="button button--quiet" data-recovery-refresh>Refresh</button></div>
      <p class="workflow-recovery-status" data-recovery-status>Recent scans appear after the current session is ready.</p>
      <div class="workflow-recovery-list" data-recovery-list></div><button type="button" class="button button--quiet" data-recovery-more hidden>Load more</button>
    </section>`;
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
  const recoveryRefresh = element.querySelector<HTMLButtonElement>("[data-recovery-refresh]");
  const recoveryStatus = element.querySelector<HTMLElement>("[data-recovery-status]");
  const recoveryList = element.querySelector<HTMLElement>("[data-recovery-list]");
  const recoveryMore = element.querySelector<HTMLButtonElement>("[data-recovery-more]");
  if (!form || !query || !scope || !selectedScopeOption || !submit || !cancel || !refresh || !status || !statusText || !detail || !progress || !progressBar || !recoveryRefresh || !recoveryStatus || !recoveryList || !recoveryMore) {
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
  let recoveredWorkflow = false;
  let recoveredCancelable = false;
  let recoveryController: AbortController | undefined;
  let recoverySerial = 0;
  let recoveryItems = new Map<string, ExhaustiveWorkflowSummary>();
  let recoveryCursor: string | undefined;

  const buttons = (): void => {
    submit.disabled = !healthReady() || busy || (workflowId !== undefined && !terminalState);
    cancel.disabled = workflowId === undefined || terminalState || cancelling || (recoveredWorkflow && !recoveredCancelable);
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

  const recoveryStateLabel = (item: ExhaustiveWorkflowSummary): string => {
    if (item.binding_state === "CANCEL_REQUESTED") return "Cancellation requested";
    if (item.job_state === "COMPLETE" || item.workflow_status === "complete") return "Complete";
    if (item.job_state === "INVALIDATED") return "Needs a fresh scan";
    if (item.workflow_status === "terminated") return "Cancelled";
    if (item.workflow_status === "errored") return "Stopped with an error";
    return statusLabel(item.workflow_status);
  };

  const recoveryDate = (value: string): string => {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
    catch { return "Recent"; }
  };

  const recoveryRow = (item: ExhaustiveWorkflowSummary): HTMLElement => {
    const row = document.createElement("div");
    row.className = "workflow-recovery-row";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "workflow-recovery-item";
    action.dataset.recoveryWorkflowId = item.workflow_instance_id;
    action.disabled = false;
    action.textContent = `${recoveryStateLabel(item)} · ${recoveryDate(item.created_at)}`;
    action.setAttribute("aria-label", `${recoveryStateLabel(item)} from ${recoveryDate(item.created_at)}`);
    const note = document.createElement("span");
    note.className = "workflow-recovery-note";
    note.textContent = item.binding_state === "CANCEL_REQUESTED"
      ? "Watching the server finish cancellation"
      : item.recoverable
      ? (item.cancelable && item.binding_state === "BOUND" ? "Active on the server · status and cancellation available" : "Active on the server · status available")
      : "Status only; start a new scan to run again";
    row.append(action, note);
    return row;
  };

  const renderRecovery = (page: ExhaustiveWorkflowPage, append = false): void => {
    const prior = append ? recoveryItems : new Map<string, ExhaustiveWorkflowSummary>();
    const merged = mergeRecoveryPage(prior, page, append);
    if (!append) recoveryList.replaceChildren();
    for (const item of page.items) {
      if (!merged.items.has(item.workflow_instance_id) || prior.has(item.workflow_instance_id)) continue;
      recoveryList.append(recoveryRow(item));
    }
    recoveryItems = merged.items;
    recoveryCursor = merged.nextCursor;
    recoveryMore.hidden = recoveryCursor === undefined;
    if (recoveryItems.size === 0) {
      recoveryStatus.textContent = page.next_cursor === undefined
        ? "No recent scans are available for this session."
        : "No scans on this page. More recent scans may be available.";
      return;
    }
    if (merged.capped) recoveryStatus.textContent = `Showing the ${MAX_RECOVERY_ITEMS} most recent scans.`;
    else if (append && merged.added === 0) recoveryStatus.textContent = page.next_cursor === undefined
      ? "No additional recent scans were found."
      : "No additional scans on this page. Load more to continue.";
    else recoveryStatus.textContent = append ? "More recent scans loaded. Choose one to check its server status." : "Choose a recent scan to check its current server status.";
  };

  const clearRecovery = (text = "Recent scans appear after the current session is ready."): void => {
    recoverySerial += 1;
    recoveryController?.abort();
    recoveryController = undefined;
    recoveryItems = new Map();
    recoveryCursor = undefined;
    recoveryList.replaceChildren();
    recoveryMore.hidden = true;
    recoveryRefresh.disabled = false;
    recoveryMore.disabled = false;
    recoveryStatus.textContent = text;
  };

  const refreshRecovery = async (cursor?: string, append = false): Promise<void> => {
    if (!healthReady() || !navigator.onLine) return;
    const generation = deploymentGeneration();
    if (generation === undefined) return;
    const active = ++recoverySerial;
    recoveryController?.abort();
    const local = new AbortController();
    recoveryController = local;
    recoveryRefresh.disabled = true;
    recoveryMore.disabled = true;
    recoveryStatus.textContent = "Checking recent scans…";
    try {
      const page = await listExhaustiveWorkflows(20, cursor, generation, local.signal);
      if (active === recoverySerial) renderRecovery(page, append);
    } catch (error: unknown) {
      if (active === recoverySerial && !(error instanceof Error && error.name === "AbortError")) {
        const accessLost = error instanceof ApiRequestError && (error.status === 401 || error.status === 403);
        const generationChanged = error instanceof ApiRequestError && error.code === "API_GENERATION_MISMATCH";
        if (accessLost || generationChanged) {
          clearPrivate();
          recoveryStatus.textContent = accessLost
            ? "Recent scans are unavailable for this session."
            : "The deployment changed. Reconnect before checking recent scans.";
        } else {
          recoveryStatus.textContent = "Recent scans could not be loaded. Try again when the service is ready.";
          if (!append) { recoveryList.replaceChildren(); recoveryMore.hidden = true; }
        }
      }
    } finally {
      if (active === recoverySerial) { recoveryController = undefined; recoveryRefresh.disabled = false; recoveryMore.disabled = false; }
    }
  };

  const selectRecovered = async (item: ExhaustiveWorkflowSummary): Promise<void> => {
    const generation = deploymentGeneration();
    if (generation === undefined || !healthReady() || !navigator.onLine) {
      recoveryStatus.textContent = "Reconnect before checking this scan.";
      return;
    }
    const active = ++serial;
    controller?.abort();
    element.dispatchEvent(new CustomEvent("exhaustive:started", {
      bubbles: true,
      detail: { recovered: true, workflow_instance_id: item.workflow_instance_id },
    }));
    const local = new AbortController();
    controller = local;
    busy = true;
    cancelling = false;
    recoveredWorkflow = true;
    recoveredCancelable = item.cancelable && item.binding_state === "BOUND";
    workflowId = item.workflow_instance_id;
    workflowGeneration = generation;
    terminalState = false;
    element.dataset.workflowId = item.workflow_instance_id;
    query.value = "";
    selectedSourceId = undefined;
    scope.value = "library";
    selectedScopeOption.disabled = true;
    status.textContent = recoveryStateLabel(item).toUpperCase();
    statusText.textContent = item.recoverable ? "Checking current server progress…" : "Checking the saved scan…";
    buttons();
    try {
      const view = await readExhaustiveWorkflow(item.workflow_instance_id, generation, local.signal);
      if (active === serial) render(view);
    } catch (error: unknown) {
      if (active === serial && !(error instanceof Error && error.name === "AbortError")) {
        if (error instanceof ApiRequestError && (error.code === "API_GENERATION_MISMATCH" || error.status === 401 || error.status === 403)) clearPrivate();
        else statusText.textContent = message(error);
      }
    } finally {
      if (active === serial) { busy = false; controller = undefined; buttons(); }
    }
  };

  recoveryRefresh.onclick = () => { void refreshRecovery(); };
  recoveryMore.onclick = () => { if (recoveryCursor !== undefined) void refreshRecovery(recoveryCursor, true); };
  recoveryList.onclick = (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-recovery-workflow-id]") : null;
    const id = target?.dataset.recoveryWorkflowId;
    const item = id === undefined ? undefined : recoveryItems.get(id);
    if (item !== undefined) void selectRecovered(item);
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
    const wasTerminal = terminalState;
    const generation = deploymentGeneration();
    const local = new AbortController(); controller = local; busy = true; workflowId = undefined; workflowGeneration = generation; terminalState = false; recoveredWorkflow = false; recoveredCancelable = false; delete element.dataset.workflowId; buttons();
    element.dispatchEvent(new CustomEvent("exhaustive:started", { bubbles: true }));
    status.textContent = "STARTING"; statusText.textContent = "Preparing the selected sources…"; detail.textContent = "Progress will be read from the server as it becomes available.";
    // A deliberate relaunch after a terminal result is a new operation even
    // when the user keeps the same query and scope. Keep the key across a
    // still-in-flight retry so a lost acknowledgement can reconcile safely.
    if (body !== previousBody || wasTerminal) { previousBody = body; idempotencyKey = crypto.randomUUID(); }
    void launchExhaustiveWorkflow(body, idempotencyKey, generation, local.signal)
      .then((view) => { if (active === serial) { workflowId = view.workflow_instance_id; element.dataset.workflowId = view.workflow_instance_id; workflowGeneration = view.deployment_generation; return reconcile(view, active, local, workflowGeneration); } return Promise.resolve(); })
      .catch((error: unknown) => { if (active === serial && !(error instanceof Error && error.name === "AbortError")) { if (error instanceof ApiRequestError && error.code === "API_GENERATION_MISMATCH") clearPrivate(); else statusText.textContent = message(error); } })
      .finally(() => { if (active === serial) { busy = false; controller = undefined; buttons(); } });
  };

  form.onsubmit = (event) => { event.preventDefault(); launch(); };
  cancel.onclick = () => {
    const id = workflowId;
    if (id === undefined) { stopWatching("Launch watch stopped. Recheck the same inputs to reconcile the server state."); return; }
    if (recoveredWorkflow && !recoveredCancelable) {
      statusText.textContent = "This scan can be viewed, but cannot be cancelled from this session.";
      return;
    }
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
    serial += 1; controller?.abort(); controller = undefined; busy = false; cancelling = false; workflowId = undefined; workflowGeneration = undefined; terminalState = false; recoveredWorkflow = false; recoveredCancelable = false; previousBody = ""; idempotencyKey = ""; selectedSourceId = undefined; delete element.dataset.workflowId;
    clearRecovery();
    status.textContent = healthReady() ? "READY" : "WAITING"; statusText.textContent = "Private scan state cleared. Reconnect before starting again."; detail.textContent = ""; progress.hidden = true; progressBar.style.width = "0%"; query.value = ""; scope.value = "library"; selectedScopeOption.disabled = true; buttons();
  };
  window.addEventListener("eliotr:authorization-cleared", clearPrivate);
  window.addEventListener("offline", clearPrivate);
  window.addEventListener("pagehide", clearPrivate);
  const onHealthUpdated = (): void => {
    refreshHealthState();
    if (healthReady()) void refreshRecovery();
    else clearRecovery();
  };
  window.addEventListener("eliotr:health-updated", onHealthUpdated);
  scope.onchange = () => { if (scope.value === "selected" && selectedSourceId === undefined) scope.value = "library"; };
  buttons();
  if (healthReady()) void refreshRecovery();
  return Object.assign(() => {
    clearPrivate(); window.removeEventListener("eliotr:authorization-cleared", clearPrivate); window.removeEventListener("offline", clearPrivate); window.removeEventListener("pagehide", clearPrivate); window.removeEventListener("eliotr:health-updated", onHealthUpdated);
  }, { clearPrivate, selectSource(id: string): void {
    if (!IdentifierSchema.safeParse(id).success) return;
    selectedSourceId = id; selectedScopeOption.disabled = false; scope.value = "selected";
  } });
}
