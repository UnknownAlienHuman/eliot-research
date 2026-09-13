import { ApiRequestError } from "./api.js";
import {
  executePreparedErasure,
  prepareErasureForOwner,
  readErasureStatus,
  type ErasurePrepareView,
  type ErasureStatusView,
} from "./erasure-api.js";
import type { LibrarySelectionContext } from "./library-readiness-api.js";

type SelectionContext = LibrarySelectionContext & {
  readonly title?: string;
  readonly source_title?: string;
};
type Phase = "idle" | "ready" | "preparing" | "confirming" | "executing" | "status" | "unknown" | "terminal";
type Selection = { readonly id: string; readonly title?: string; readonly generation?: string };

export interface ErasurePanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
}

const PURGE_STAGE_LABELS: Readonly<Record<string, string>> = {
  REQUESTED: "Request received",
  QUARANTINE_AND_REVOKE: "Securing the document",
  ENUMERATE_DEPENDENCY_CLOSURE: "Checking dependent copies",
  CHECK_RETENTION_AND_HOLDS: "Checking retention and holds",
  PURGE_EACH_LOCATION: "Removing permitted copies",
  VERIFY_ABSENCE_OR_BLOCK: "Verifying removal",
  APPEND_PURGE_LEDGER: "Recording the result",
  INVALIDATE_DEPENDENTS: "Updating dependent records",
  COMPLETE: "Deleted",
  BLOCKED: "Blocked",
};

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function selectedTitle(context?: SelectionContext): string | undefined {
  const candidate = context?.title ?? context?.source_title;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

function displayTitle(selection: Selection | undefined): string {
  return selection?.title ?? "Selected document";
}

function stageLabel(state: ErasureStatusView["state"]): string {
  return state === "UNKNOWN" ? "Unknown" : PURGE_STAGE_LABELS[state] ?? "Processing deletion";
}

function isTerminal(state: ErasureStatusView["state"]): state is "COMPLETE" | "BLOCKED" {
  return state === "COMPLETE" || state === "BLOCKED";
}

function isPermissionFailure(error: unknown): boolean {
  return error instanceof ApiRequestError &&
    (error.code === "ERASURE_PERMISSION_DENIED" || error.code === "ERASURE_PERMISSION_NOT_INSTALLED");
}

function isPrivateFailure(error: unknown): boolean {
  return error instanceof ApiRequestError &&
    (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409 ||
      error.code === "API_GENERATION_MISMATCH" || error.code === "ERASURE_DEPLOYMENT_CHANGED");
}

function failureText(error: unknown, operation: "prepare" | "execute" | "status"): string {
  if (isPermissionFailure(error)) return "Deletion permission is not installed for this workspace.";
  if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
    return "Authorization changed. Sign in again before reviewing deletion.";
  }
  if (error instanceof ApiRequestError && (error.status === 409 || error.code === "API_GENERATION_MISMATCH" ||
      error.code === "ERASURE_DEPLOYMENT_CHANGED")) {
    return "The workspace changed. Select the document again before reviewing deletion.";
  }
  if (operation === "prepare" && error instanceof ApiRequestError && error.code === "ERASURE_SETTLEMENT_UNCERTAIN") {
    return "Deletion is unavailable because the workspace could not confirm its permission. Try again after workspace setup.";
  }
  if (operation === "prepare") return "The deletion review could not be prepared. Try again when the workspace is ready.";
  if (operation === "status") return "The saved deletion status could not be read. Try Refresh status again.";
  return "The deletion result could not be confirmed. Use Refresh status to read the saved request.";
}

/**
 * Owner-only deletion review and execution. No request is sent to the execute
 * route until the user has reviewed the server-produced exact request and
 * explicitly confirmed the irreversible action.
 */
export function mountErasurePanel(
  element: HTMLElement,
  options: ErasurePanelOptions,
): (() => void) & { clearPrivate(): void; selectSource(id: string, context?: SelectionContext): void } {
  element.innerHTML = `
    <div class="workflow-head">
      <div><span class="eyebrow">Document privacy</span><h2>Delete a document</h2></div>
      <span class="workflow-badge" data-erasure-state>No document selected</span>
    </div>
    <p class="workflow-copy" data-erasure-intro>Select a document in Library to review deletion.</p>
    <section class="readiness-card" data-erasure-selection hidden>
      <h3 data-erasure-title>Selected document</h3>
      <p data-erasure-selection-copy>Review the exact document before any deletion is requested.</p>
      <details>
        <summary>Document details</summary>
        <dl>
          <dt>Source</dt><dd><code data-erasure-source></code></dd>
          <dt>Exact records</dt><dd data-erasure-count>Not prepared</dd>
        </dl>
      </details>
    </section>
    <div class="workflow-actions">
      <button type="button" class="button" data-erasure-prepare disabled>Delete document</button>
      <button type="button" class="button button--quiet" data-erasure-refresh disabled>Refresh status</button>
    </div>
    <section class="workflow-recovery" data-erasure-preview hidden aria-labelledby="erasure-review-title">
      <div class="workflow-recovery-head"><div><span class="eyebrow">Review deletion</span><h3 id="erasure-review-title">Confirm the exact document</h3></div></div>
      <p class="workflow-recovery-status" data-erasure-preview-copy></p>
      <p class="workflow-recovery-note">Deletion is irreversible. It can be blocked by a retention policy or hold; the result will say what happened.</p>
      <label><input type="checkbox" data-erasure-confirmation> I understand that this permanently deletes this exact document and its permitted copies.</label>
      <div class="workflow-actions"><button type="button" class="button" data-erasure-confirm disabled>Delete this document permanently</button><button type="button" class="button button--quiet" data-erasure-cancel>Keep document</button></div>
    </section>
    <p class="workflow-status" role="status" aria-live="polite" data-erasure-status>Choose a document from Library before reviewing deletion.</p>
    <section class="workflow-recovery" data-erasure-result hidden aria-labelledby="erasure-result-title">
      <div class="workflow-recovery-head"><div><span class="eyebrow">Deletion result</span><h3 id="erasure-result-title">Saved request</h3></div></div>
      <p class="workflow-recovery-status" data-erasure-result-copy></p>
      <details><summary>Request details</summary><dl>
        <dt>Request</dt><dd><code data-erasure-ref></code></dd>
        <dt>Server trace</dt><dd><code data-erasure-trace></code></dd>
      </dl></details>
    </section>`;

  const stateNode = element.querySelector<HTMLElement>("[data-erasure-state]");
  const introNode = element.querySelector<HTMLElement>("[data-erasure-intro]");
  const selectionNode = element.querySelector<HTMLElement>("[data-erasure-selection]");
  const titleNode = element.querySelector<HTMLElement>("[data-erasure-title]");
  const selectionCopyNode = element.querySelector<HTMLElement>("[data-erasure-selection-copy]");
  const sourceNode = element.querySelector<HTMLElement>("[data-erasure-source]");
  const countNode = element.querySelector<HTMLElement>("[data-erasure-count]");
  const prepareButton = element.querySelector<HTMLButtonElement>("[data-erasure-prepare]");
  const refreshButton = element.querySelector<HTMLButtonElement>("[data-erasure-refresh]");
  const previewNode = element.querySelector<HTMLElement>("[data-erasure-preview]");
  const previewCopyNode = element.querySelector<HTMLElement>("[data-erasure-preview-copy]");
  const confirmationInput = element.querySelector<HTMLInputElement>("[data-erasure-confirmation]");
  const confirmButton = element.querySelector<HTMLButtonElement>("[data-erasure-confirm]");
  const cancelButton = element.querySelector<HTMLButtonElement>("[data-erasure-cancel]");
  const statusNode = element.querySelector<HTMLElement>("[data-erasure-status]");
  const resultNode = element.querySelector<HTMLElement>("[data-erasure-result]");
  const resultCopyNode = element.querySelector<HTMLElement>("[data-erasure-result-copy]");
  const erasureRefNode = element.querySelector<HTMLElement>("[data-erasure-ref]");
  const traceNode = element.querySelector<HTMLElement>("[data-erasure-trace]");
  if (!stateNode || !introNode || !selectionNode || !titleNode || !selectionCopyNode || !sourceNode || !countNode ||
      !prepareButton || !refreshButton || !previewNode || !previewCopyNode || !confirmationInput || !confirmButton ||
      !cancelButton || !statusNode || !resultNode || !resultCopyNode || !erasureRefNode || !traceNode) {
    throw new Error("Erasure panel is incomplete");
  }

  let disposed = false;
  let serial = 0;
  let controller: AbortController | undefined;
  let phase: Phase = "idle";
  let selection: Selection | undefined;
  let prepared: ErasurePrepareView | undefined;
  let statusView: ErasureStatusView | undefined;
  let erasureRef: ErasurePrepareView["request"]["request"]["erasure_ref"] | undefined;
  let confirmationAccepted = false;
  let executeAttempted = false;
  let sourceErasedDispatched = false;
  let statusMessage = "Choose a document from Library before reviewing deletion.";
  let lastGeneration: string | undefined;

  const currentGeneration = (): string | undefined => {
    const generation = options.deploymentGeneration();
    return generation !== undefined && generation !== "" && generation !== "unreachable" && generation !== "generation pending"
      ? generation : undefined;
  };
  const canRequest = (): boolean => options.healthReady() && isOnline() && currentGeneration() !== undefined;

  const stopRequest = (): void => {
    serial += 1;
    controller?.abort();
    controller = undefined;
  };

  const refText = (): string => erasureRef === undefined ? "" : `${erasureRef.id}@${erasureRef.revision}`;

  const statusPresentation = (): { readonly label: string; readonly intro: string } => {
    if (selection === undefined) return { label: "No document selected", intro: "Select a document in Library to review deletion." };
    if (phase === "preparing") return { label: "Preparing review", intro: "Preparing an exact deletion review." };
    if (phase === "confirming") return { label: "Review required", intro: "Review the exact document below before confirming deletion." };
    if (phase === "executing") return { label: "Deleting", intro: "Submitting the prepared deletion request." };
    if (phase === "unknown") return { label: "Unknown", intro: "The deletion result is unknown. Refresh status to read the saved request." };
    if (phase === "terminal" && statusView?.state === "COMPLETE") return { label: "Complete", intro: "The exact document deletion is complete." };
    if (phase === "terminal" && statusView?.state === "BLOCKED") return { label: "Blocked", intro: "Deletion was blocked; the result below explains the hold or policy." };
    if (phase === "status" && statusView !== undefined) return { label: stageLabel(statusView.state), intro: "The saved deletion request is still processing. Refresh status for the latest result." };
    if (phase === "status") return { label: "Checking", intro: "Reading the saved deletion status." };
    return { label: "Ready", intro: "Review the selected document before any deletion is requested." };
  };

  const renderResult = (): void => {
    const showResult = prepared !== undefined &&
      (phase === "unknown" || phase === "status" || phase === "terminal");
    resultNode.hidden = !showResult;
    if (!showResult) return;
    if (phase === "unknown") {
      resultCopyNode.textContent = statusMessage;
    } else if (phase === "status" && statusView !== undefined) {
      resultCopyNode.textContent = statusView.state === "UNKNOWN"
        ? "No confirmed deletion result is available yet. The outcome remains unknown."
        : `${stageLabel(statusView.state)}. Refresh status again while the request is being processed.`;
    } else if (statusView?.state === "COMPLETE") {
      resultCopyNode.textContent = "The exact document and all locations confirmed by the server were deleted.";
    } else if (statusView?.state === "BLOCKED") {
      const blocked = statusView.receipt?.blocked_locations.length ?? 0;
      resultCopyNode.textContent = blocked > 0
        ? `Deletion is blocked by ${blocked} retention policy or hold. The server has not claimed complete removal.`
        : "Deletion is blocked. The server has not claimed complete removal.";
    }
    erasureRefNode.textContent = refText();
    const currentPrepared = prepared;
    traceNode.textContent = statusView?.trace_id ?? (currentPrepared === undefined ? "" : currentPrepared.trace_id);
  };

  const render = (): void => {
    const presentation = statusPresentation();
    stateNode.textContent = presentation.label;
    introNode.textContent = presentation.intro;
    selectionNode.hidden = selection === undefined;
    titleNode.textContent = displayTitle(selection);
    selectionCopyNode.textContent = selection === undefined
      ? "Review the exact document before any deletion is requested."
      : "The server will prepare the exact records before you confirm anything.";
    sourceNode.textContent = selection?.id ?? "";
    countNode.textContent = prepared === undefined ? "Not prepared" : `${prepared.revision_targets.length}`;
    prepareButton.disabled = selection === undefined || !canRequest() || phase === "preparing" || phase === "executing" ||
      phase === "confirming" || phase === "status" || phase === "unknown" || phase === "terminal" || executeAttempted;
    refreshButton.disabled = erasureRef === undefined || !canRequest() || controller !== undefined || phase === "preparing" || phase === "executing";
    previewNode.hidden = prepared === undefined || phase !== "confirming";
    if (prepared !== undefined) {
      previewCopyNode.textContent = `The server prepared deletion of ${prepared.revision_targets.length} exact record${prepared.revision_targets.length === 1 ? "" : "s"} for “${prepared.source_title}”. Check the document name and confirm the irreversible action.`;
    }
    confirmationInput.checked = confirmationAccepted;
    confirmButton.disabled = prepared === undefined || phase !== "confirming" || !confirmationAccepted || !canRequest();
    statusNode.textContent = statusMessage;
    statusNode.setAttribute("aria-busy", controller === undefined ? "false" : "true");
    renderResult();
  };

  const resetFlow = (message: string): void => {
    stopRequest();
    phase = selection === undefined ? "idle" : "ready";
    prepared = undefined;
    statusView = undefined;
    erasureRef = undefined;
    confirmationAccepted = false;
    executeAttempted = false;
    sourceErasedDispatched = false;
    statusMessage = message;
    render();
  };

  const clearPrivate = (message = "Deletion review cleared. Select the document again when the workspace is ready."): void => {
    stopRequest();
    selection = undefined;
    lastGeneration = undefined;
    phase = "idle";
    prepared = undefined;
    statusView = undefined;
    erasureRef = undefined;
    confirmationAccepted = false;
    executeAttempted = false;
    sourceErasedDispatched = false;
    statusMessage = message;
    render();
  };

  const stillCurrent = (active: number, generation: string): boolean => {
    if (disposed || active !== serial) return false;
    const current = currentGeneration();
    if (current !== generation) {
      clearPrivate("The workspace changed. Select the document again before reviewing deletion.");
      return false;
    }
    return true;
  };

  const applyFailure = (error: unknown, operation: "prepare" | "execute" | "status"): void => {
    if (isPrivateFailure(error) && !isPermissionFailure(error)) {
      clearPrivate(failureText(error, operation));
      return;
    }
    statusMessage = failureText(error, operation);
    if (operation === "prepare") {
      phase = "ready";
    } else {
      phase = "unknown";
    }
    render();
  };

  const prepare = async (): Promise<void> => {
    if (selection === undefined || !canRequest() || phase === "preparing" || phase === "executing") return;
    const generation = currentGeneration();
    if (generation === undefined) {
      statusMessage = "The owner workspace is unavailable. Check the server before reviewing deletion.";
      render();
      return;
    }
    stopRequest();
    const active = serial;
    const local = new AbortController();
    controller = local;
    phase = "preparing";
    statusMessage = "Preparing the exact deletion review…";
    render();
    try {
      const key = crypto.randomUUID();
      const response = await prepareErasureForOwner(selection.id, key, generation, local.signal);
      if (!stillCurrent(active, generation)) return;
      const currentSelection = selection;
      selection = currentSelection.title === response.source_title
        ? currentSelection
        : (currentSelection.generation === undefined
          ? { id: currentSelection.id, title: response.source_title }
          : { id: currentSelection.id, title: response.source_title, generation: currentSelection.generation });
      prepared = response;
      statusView = undefined;
      erasureRef = response.request.request.erasure_ref;
      confirmationAccepted = false;
      executeAttempted = false;
      phase = "confirming";
      statusMessage = "Review the exact document and confirm the irreversible deletion when ready.";
      render();
    } catch (error) {
      if (active !== serial || (error instanceof Error && error.name === "AbortError")) return;
      applyFailure(error, "prepare");
    } finally {
      if (active === serial) { controller = undefined; render(); }
    }
  };

  const execute = async (): Promise<void> => {
    if (prepared === undefined || !confirmationAccepted || phase !== "confirming" || executeAttempted || !canRequest()) return;
    const generation = currentGeneration();
    if (generation === undefined) {
      clearPrivate("The workspace changed. Select the document again before reviewing deletion.");
      return;
    }
    stopRequest();
    const active = serial;
    const local = new AbortController();
    controller = local;
    const preparedRequest = prepared;
    executeAttempted = true;
    phase = "executing";
    statusMessage = "Submitting the prepared deletion request…";
    render();
    try {
      const receipt = await executePreparedErasure(preparedRequest, generation, local.signal);
      if (!stillCurrent(active, generation)) return;
      statusView = {
        protocol: "eliotr.owner-erasure-status.v1",
        erasure_ref: receipt.erasure_ref,
        state: receipt.state,
        receipt,
        trace_id: preparedRequest.trace_id,
        deployment_generation: generation,
      };
      erasureRef = receipt.erasure_ref;
      phase = "terminal";
      if (receipt.state === "COMPLETE" && !sourceErasedDispatched) {
        sourceErasedDispatched = true;
        element.dispatchEvent(new CustomEvent("eliotr:source-erased", {
          bubbles: true,
          detail: { sourceId: selection?.id },
        }));
      }
      statusMessage = receipt.state === "COMPLETE"
        ? "Deletion completed for the exact document."
        : "Deletion is blocked; review the server result below.";
      render();
    } catch (error) {
      if (active !== serial || (error instanceof Error && error.name === "AbortError")) return;
      applyFailure(error, "execute");
    } finally {
      if (active === serial) { controller = undefined; render(); }
    }
  };

  const refreshStatus = async (): Promise<void> => {
    if (erasureRef === undefined || !canRequest() || controller !== undefined || phase === "preparing" || phase === "executing") return;
    const generation = currentGeneration();
    if (generation === undefined) {
      clearPrivate("The workspace changed. Select the document again before reviewing deletion.");
      return;
    }
    const reference = erasureRef;
    stopRequest();
    const active = serial;
    const local = new AbortController();
    controller = local;
    phase = "status";
    statusMessage = "Reading the saved deletion status…";
    render();
    try {
      const response = await readErasureStatus(reference, generation, local.signal);
      if (!stillCurrent(active, generation)) return;
      if (response === null) {
        statusView = undefined;
        phase = "unknown";
        statusMessage = "No saved deletion result is available yet. The outcome remains unknown.";
      } else {
        statusView = response;
        phase = isTerminal(response.state) ? "terminal" : response.state === "UNKNOWN" ? "unknown" : "status";
        if (response.state === "COMPLETE" && !sourceErasedDispatched) {
          sourceErasedDispatched = true;
          element.dispatchEvent(new CustomEvent("eliotr:source-erased", {
            bubbles: true,
            detail: { sourceId: selection?.id },
          }));
        }
        statusMessage = response.state === "UNKNOWN"
          ? "The saved deletion result is unknown. Refresh status again if the request should be durable."
          : response.state === "COMPLETE"
            ? "Deletion completed for the exact document."
            : response.state === "BLOCKED"
              ? "Deletion is blocked; review the server result below."
              : `${stageLabel(response.state)}. Refresh status again while the request is being processed.`;
      }
      render();
    } catch (error) {
      if (active !== serial || (error instanceof Error && error.name === "AbortError")) return;
      applyFailure(error, "status");
    } finally {
      if (active === serial) { controller = undefined; render(); }
    }
  };

  prepareButton.onclick = () => { void prepare(); };
  refreshButton.onclick = () => { void refreshStatus(); };
  confirmButton.onclick = () => { void execute(); };
  cancelButton.onclick = () => resetFlow("Deletion review cancelled. The document was not changed.");
  confirmationInput.onchange = () => {
    confirmationAccepted = confirmationInput.checked;
    render();
  };

  const onOffline = (): void => clearPrivate("The deletion review was cleared while offline. Reconnect before selecting the document again.");
  const onAuthorizationCleared = (): void => clearPrivate("Authorization changed. The deletion review was cleared; sign in again before retrying.");
  const onHealthLost = (): void => clearPrivate("The workspace changed. The deletion review was cleared; check the server before selecting the document again.");
  const onHealthUpdated = (): void => {
    const generation = currentGeneration();
    if (selection !== undefined && (!options.healthReady() || !isOnline() || generation === undefined ||
        (lastGeneration !== undefined && lastGeneration !== generation))) {
      clearPrivate("The workspace changed. The deletion review was cleared; select the document again when ready.");
      return;
    }
    render();
  };
  const onPageHide = (): void => clearPrivate("Deletion review cleared when the page was closed.");
  window.addEventListener("offline", onOffline);
  window.addEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
  window.addEventListener("eliotr:health-updated", onHealthUpdated);
  window.addEventListener("pagehide", onPageHide);
  const app = element.closest("#app");
  app?.addEventListener("eliotr:health-lost", onHealthLost);

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    stopRequest();
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
    window.removeEventListener("eliotr:health-updated", onHealthUpdated);
    window.removeEventListener("pagehide", onPageHide);
    app?.removeEventListener("eliotr:health-lost", onHealthLost);
    element.replaceChildren();
  };

  render();
  return Object.assign(cleanup, {
    clearPrivate,
    selectSource(id: string, context?: SelectionContext): void {
      if (disposed) return;
      if (id === "") {
        clearPrivate("Select a document in Library before reviewing deletion.");
        return;
      }
      const generation = context?.deploymentGeneration ?? currentGeneration();
      const title = selectedTitle(context);
      const currentSelection = selection;
      if (currentSelection !== undefined && currentSelection.id === id && currentSelection.generation === generation) {
        if (title !== undefined && currentSelection.title !== title) {
          selection = generation === undefined
            ? { id, title }
            : { id, title, generation };
        }
        lastGeneration = generation;
        render();
        return;
      }
      selection = title === undefined
        ? (generation === undefined ? { id } : { id, generation })
        : (generation === undefined ? { id, title } : { id, title, generation });
      lastGeneration = generation;
      resetFlow("Review the selected document before any deletion is requested.");
    },
  });
}
