import {
  readResearchProviderKeyConfigurations,
  type ResearchProviderKeyConfiguration,
} from "./research-provider-key-api.js";
import {
  readResearchProviderKeyModelSelection,
  readResearchProviderKeyModelUse,
  startResearchProviderKeyModelUse,
  type ResearchProviderKeyModelUseOperation,
  type ResearchProviderKeyModelUseState,
  type ResearchProviderKeyModelUseSelection,
} from "./research-provider-key-model-use-api.js";
import {
  clearAllRecoveries,
  clearRecovery,
  currentGeneration,
  errorCopy,
  failureCopy,
  isOnline,
  keyStatusLabel,
  phaseLabel,
  readRecovery,
  RECOVERY_PROTOCOL,
  selectionLabel,
  stateLabel,
  useIsActive,
  writeRecovery,
  type RecoveryRecord,
  type ResearchProviderKeyModelUsePanelOptions,
  type Tone,
} from "./research-provider-key-model-use-state.js";

export type { ResearchProviderKeyModelUsePanelOptions } from "./research-provider-key-model-use-state.js";

export function mountResearchProviderKeyModelUsePanel(
  element: HTMLElement,
  options: ResearchProviderKeyModelUsePanelOptions,
): (() => void) & { clearPrivate(message?: string): void; refresh(): void } {
  element.innerHTML = `<section class="research-provider-key-model-use" aria-labelledby="research-provider-key-use-title">
    <div class="connection-heading"><div><span class="eyebrow">Model selection</span><h3 id="research-provider-key-use-title">Check and use a saved key</h3></div><span class="connection-state connection-state--unknown" data-key-use-badge>NOT CHECKED</span></div>
    <p data-key-use-summary role="status" aria-live="polite">Select a project in Sources to check safe key and model status.</p>
    <p data-key-use-explanation>This is a separate owner action. It uses a saved key-operation reference, never the key value. The server enforces the free-price gate and exact-route qualification; a model is active only after selected-configuration readback.</p>
    <p class="connection-note" data-key-use-selection>Current project model selection has not been checked.</p>
    <p class="connection-note" data-key-use-operation role="status" aria-live="polite" hidden></p>
    <ul data-key-use-configurations aria-label="Saved OpenRouter key operations"></ul>
    <div class="connection-actions"><button class="button button--quiet" type="button" data-key-use-refresh disabled>Refresh key and model status</button><button class="button button--quiet" type="button" data-key-use-status hidden disabled>Refresh exact operation status</button></div>
  </section>`;

  const root = element.querySelector<HTMLElement>(".research-provider-key-model-use");
  const badge = root?.querySelector<HTMLElement>("[data-key-use-badge]");
  const summary = root?.querySelector<HTMLElement>("[data-key-use-summary]");
  const explanation = root?.querySelector<HTMLElement>("[data-key-use-explanation]");
  const selectionLabelNode = root?.querySelector<HTMLElement>("[data-key-use-selection]");
  const operationNode = root?.querySelector<HTMLElement>("[data-key-use-operation]");
  const configurationsHost = root?.querySelector<HTMLUListElement>("[data-key-use-configurations]");
  const refreshButton = root?.querySelector<HTMLButtonElement>("[data-key-use-refresh]");
  const statusButton = root?.querySelector<HTMLButtonElement>("[data-key-use-status]");
  if (!root || !badge || !summary || !explanation || !selectionLabelNode || !operationNode ||
      !configurationsHost || !refreshButton || !statusButton) throw new Error("Provider-key model-use panel is incomplete");

  const app = element.closest<HTMLElement>("#app");
  let disposed = false;
  let serial = 0;
  let projectId: string | undefined;
  let ownerScopeEpoch = options.ownerSessionScopeEpoch();
  let requestController: AbortController | undefined;
  let busy = false;
  let statusRead = false;
  let keyConfigurations: readonly ResearchProviderKeyConfiguration[] = [];
  let selection: ResearchProviderKeyModelUseSelection | undefined;
  let recovery: RecoveryRecord | undefined;
  let recoveryGenerationChanged = false;
  let operation: ResearchProviderKeyModelUseOperation | undefined;
  let selectionConfirmed = false;
  let readbackPending = false;
  let storageUnavailable = false;
  let currentSummary = "Select a project in Sources to check safe key and model status.";
  let currentDetail = "This is a separate owner action; no key value or model configuration is sent.";
  let currentTone: Tone = "unknown";

  const contextReady = (): boolean => projectId !== undefined && options.healthReady() && isOnline() &&
    currentGeneration(options) !== undefined && ownerScopeEpoch !== undefined &&
    options.ownerSessionScopeEpoch() === ownerScopeEpoch;
  const canStart = (): boolean => contextReady() && statusRead && !busy && !useIsActive(operation) && !readbackPending &&
    recovery === undefined;
  const requestStillCurrent = (mine: number, projectAtStart: string, generationAtStart: string,
    ownerAtStart: number): boolean => mine === serial && !disposed && projectId === projectAtStart &&
    currentGeneration(options) === generationAtStart && options.ownerSessionScopeEpoch() === ownerAtStart &&
    ownerScopeEpoch === ownerAtStart && options.healthReady() && isOnline();

  const renderOperation = (): void => {
    operationNode.hidden = true;
    operationNode.textContent = "";
    if (operation !== undefined) {
      operationNode.hidden = false;
      const parts = [stateLabel(operation.state), phaseLabel(operation.phase)];
      if (operation.state === "selected" && selectionConfirmed && selection?.selection_revision === operation.selection_revision &&
          selection.selected_configuration_ref === operation.selected_configuration_ref) {
        parts.push(`Current project selection confirmed at revision ${operation.selection_revision}.`);
      } else if (operation.failure_code !== null) {
        parts.push(failureCopy(operation.failure_code));
      } else if (operation.state === "selected" && readbackPending) {
        parts.push("Current selected configuration is not yet confirmed; refresh before another action.");
      } else if (operation.state === "uncertain") {
        parts.push("The request may have reached qualification. Do not retry; read this operation only.");
      }
      operationNode.textContent = parts.join(" · ");
      return;
    }
    if (recovery !== undefined) {
      operationNode.hidden = false;
      operationNode.textContent = recoveryGenerationChanged
        ? `An operation from deployment ${recovery.deployment_generation} is unresolved. The server changed; refresh this exact status before taking another action.`
        : "A check-and-use operation is unconfirmed. Refresh its exact status; it will not be submitted again.";
      return;
    }
    if (storageUnavailable) {
      operationNode.hidden = false;
      operationNode.textContent = "This tab could not save recovery metadata. Keep it open until the exact operation reaches a terminal status; the provider key is never stored here.";
    }
  };

  const render = (): void => {
    const ready = contextReady();
    if (projectId === undefined) {
      badge.className = "connection-state connection-state--blocked";
      badge.textContent = "PROJECT REQUIRED";
      summary.textContent = "Select a project in Sources to check safe key and model status.";
      explanation.textContent = "No request was sent. Key values are never read by this model-selection control.";
    } else if (!options.healthReady() || !isOnline() || currentGeneration(options) === undefined) {
      badge.className = "connection-state connection-state--blocked";
      badge.textContent = "SERVER UNAVAILABLE";
      summary.textContent = isOnline() ? "The owner API is not ready for model selection." : "Offline. Key and model status are not cached.";
      explanation.textContent = "Reconnect and verify the owner session before refreshing or starting an operation.";
    } else if (ownerScopeEpoch === undefined || options.ownerSessionScopeEpoch() !== ownerScopeEpoch) {
      badge.className = "connection-state connection-state--blocked";
      badge.textContent = "OWNER SESSION REQUIRED";
      summary.textContent = "Verify the current owner session before checking or using a key.";
      explanation.textContent = "The check-and-use endpoint receives only operation IDs and the current selection revision.";
    } else if (busy) {
      badge.className = "connection-state connection-state--pending";
      badge.textContent = "CHECKING";
      summary.textContent = currentSummary;
      explanation.textContent = currentDetail;
    } else {
      badge.className = `connection-state connection-state--${currentTone}`;
      badge.textContent = currentTone === "selected" ? "MODEL SELECTED" : currentTone === "configured" ? "KEY SAVED" :
        currentTone === "blocked" ? "ACTION BLOCKED" : currentTone === "pending" ? "ACTION IN PROGRESS" : "STATUS READ";
      summary.textContent = currentSummary;
      explanation.textContent = currentDetail;
    }
    selectionLabelNode.textContent = selectionLabel(selection);
    const recoveryBlocks = recovery !== undefined || readbackPending || useIsActive(operation);
    for (const item of keyConfigurations) {
      let row = configurationsHost.querySelector<HTMLLIElement>(`li[data-key-operation-id="${CSS.escape(item.operation_id)}"]`);
      if (row === null) {
        row = document.createElement("li");
        row.dataset.keyOperationId = item.operation_id;
        const label = document.createElement("span");
        label.dataset.keyStatusLabel = "";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button button--quiet";
        button.dataset.keyUseAction = "";
        button.textContent = "Check and use for new research";
        row.append(label, button);
        configurationsHost.append(row);
      }
      const label = row.querySelector<HTMLElement>("[data-key-status-label]");
      const button = row.querySelector<HTMLButtonElement>("[data-key-use-action]");
      if (label) label.textContent = keyStatusLabel(item.status);
      if (button) {
        button.hidden = item.status !== "configured_not_qualified";
        button.disabled = !canStart() || recoveryBlocks;
        button.dataset.keyOperationId = item.operation_id;
        button.setAttribute("aria-label", `Check and use saved key operation ${item.operation_id} for new research`);
      }
    }
    const ids = new Set(keyConfigurations.map((item) => item.operation_id));
    configurationsHost.querySelectorAll<HTMLLIElement>("li[data-key-operation-id]").forEach((row) => {
      if (!ids.has(row.dataset.keyOperationId ?? "")) row.remove();
    });
    refreshButton.disabled = !ready || busy;
    statusButton.hidden = recovery === undefined;
    statusButton.disabled = !ready || busy || recovery === undefined;
    root.setAttribute("aria-busy", busy ? "true" : "false");
    renderOperation();
  };

  const buildRecovery = (project: string, generation: string, operationId: string, keyOperationId: string): RecoveryRecord =>
    Object.freeze({ protocol: RECOVERY_PROTOCOL, project_id: project, project_scope_ref: `project:${project}`,
      deployment_generation: generation, operation_id: operationId, key_operation_id: keyOperationId });

  const clearPrivate = (message = "Key and model status cleared."): void => {
    serial += 1;
    requestController?.abort();
    requestController = undefined;
    busy = false;
    statusRead = false;
    keyConfigurations = [];
    selection = undefined;
    recovery = undefined;
    recoveryGenerationChanged = false;
    operation = undefined;
    selectionConfirmed = false;
    readbackPending = false;
    storageUnavailable = false;
    currentSummary = message;
    currentDetail = "Reconnect and verify the owner session before checking status again.";
    currentTone = "blocked";
    render();
  };

  const abortForContextChange = (): void => {
    serial += 1;
    requestController?.abort();
    requestController = undefined;
    busy = false;
  };

  const setRecovery = (record: RecoveryRecord): void => {
    recovery = record;
    storageUnavailable = !writeRecovery(record);
  };

  const terminal = (state: ResearchProviderKeyModelUseState): boolean =>
    state === "selected" || state === "blocked" || state === "conflict";

  const verifySelectionReadback = async (result: ResearchProviderKeyModelUseOperation,
    mine: number, projectAtStart: string, generationAtStart: string, ownerAtStart: number,
    signal: AbortSignal): Promise<void> => {
    readbackPending = true;
    selectionConfirmed = false;
    currentSummary = "The server reports a selection. Reading the exact current project configuration before claiming it is active.";
    currentDetail = "The report is not treated as current until its configuration reference and revision match the server readback.";
    render();
    const actual = await readResearchProviderKeyModelSelection(projectAtStart, generationAtStart, signal);
    if (!requestStillCurrent(mine, projectAtStart, generationAtStart, ownerAtStart)) return;
    selection = actual;
    readbackPending = false;
    const matches = actual.selection_revision === result.selection_revision &&
      actual.selected_configuration_ref === result.selected_configuration_ref && actual.qualification_state === "qualified";
    selectionConfirmed = matches;
    if (matches) {
      recovery = undefined;
      clearRecovery(projectAtStart);
      recoveryGenerationChanged = false;
      currentSummary = `The new project model configuration is selected and verified at revision ${actual.selection_revision}.`;
      currentDetail = "The exact selected-configuration readback matches the server operation. Existing runs remain pinned to their saved configuration.";
      currentTone = "selected";
      storageUnavailable = false;
    } else {
      recovery = undefined;
      clearRecovery(projectAtStart);
      recoveryGenerationChanged = false;
      currentSummary = "The latest project readback does not match the configuration reported by this operation.";
      currentDetail = "The current server readback is authoritative. No claim is made that this operation remains selected; review the current project model configuration before another action.";
      currentTone = "blocked";
    }
  };

  const acceptOperation = async (result: ResearchProviderKeyModelUseOperation,
    mine: number, projectAtStart: string, generationAtStart: string, ownerAtStart: number,
    signal: AbortSignal): Promise<void> => {
    operation = result;
    if (recovery !== undefined && recovery.deployment_generation !== generationAtStart) {
      recovery = buildRecovery(projectAtStart, generationAtStart, result.operation_id, result.key_operation_id);
      storageUnavailable = !writeRecovery(recovery);
      recoveryGenerationChanged = false;
    }
    if (result.state === "selected") {
      try {
        await verifySelectionReadback(result, mine, projectAtStart, generationAtStart, ownerAtStart, signal);
      } catch {
        if (!requestStillCurrent(mine, projectAtStart, generationAtStart, ownerAtStart)) return;
        readbackPending = true;
        selectionConfirmed = false;
        currentTone = "pending";
        currentSummary = "The server reported a selected configuration, but the current project readback is unavailable.";
        currentDetail = "Refresh this exact operation to verify the selected reference and revision. No new check-and-use request will be sent automatically.";
      }
      return;
    }
    readbackPending = false;
    selectionConfirmed = false;
    if (terminal(result.state)) {
      recovery = undefined;
      clearRecovery(projectAtStart);
      recoveryGenerationChanged = false;
      storageUnavailable = false;
      currentTone = result.state === "conflict" ? "blocked" : result.state === "blocked" ? "blocked" : "unknown";
      currentSummary = `${stateLabel(result.state)} · ${phaseLabel(result.phase)}.`;
      currentDetail = result.failure_code === null ? "The operation is terminal. Refresh current selection before a new explicit action." : failureCopy(result.failure_code);
      try {
        selection = await readResearchProviderKeyModelSelection(projectAtStart, generationAtStart, signal);
        if (!requestStillCurrent(mine, projectAtStart, generationAtStart, ownerAtStart)) return;
      } catch {
        if (!requestStillCurrent(mine, projectAtStart, generationAtStart, ownerAtStart)) return;
        selection = undefined;
        currentDetail += " Current project selection readback is not available yet.";
      }
      return;
    }
    recovery = buildRecovery(projectAtStart, generationAtStart, result.operation_id, result.key_operation_id);
    storageUnavailable = !writeRecovery(recovery);
    recoveryGenerationChanged = false;
    currentTone = result.state === "uncertain" ? "blocked" : "pending";
    currentSummary = `${stateLabel(result.state)} · ${phaseLabel(result.phase)}.`;
    currentDetail = result.state === "uncertain"
      ? "The provider qualification may have been dispatched. Do not retry; refresh this exact operation only."
      : "The server has not confirmed a new selected configuration. Refresh this exact operation; no second request is sent automatically.";
  };

  const reconcileExact = async (mine: number, projectAtStart: string, generationAtStart: string,
    ownerAtStart: number, signal: AbortSignal): Promise<void> => {
    const record = recovery;
    if (record === undefined) return;
    const result = await readResearchProviderKeyModelUse(projectAtStart, generationAtStart,
      record.key_operation_id, record.operation_id, signal);
    if (!requestStillCurrent(mine, projectAtStart, generationAtStart, ownerAtStart)) return;
    await acceptOperation(result, mine, projectAtStart, generationAtStart, ownerAtStart, signal);
  };

  const refresh = (): void => {
    if (disposed || busy) return;
    const generation = currentGeneration(options);
    const ownerAtStart = options.ownerSessionScopeEpoch();
    if (projectId === undefined || generation === undefined || ownerAtStart === undefined ||
        ownerAtStart !== ownerScopeEpoch || !options.healthReady() || !isOnline()) {
      render();
      return;
    }
    const projectAtStart = projectId;
    const mine = ++serial;
    const local = new AbortController();
    requestController = local;
    busy = true;
    statusRead = false;
    currentSummary = "Reading saved key operations and the current project model selection…";
    currentDetail = "These are owner-scoped GET requests. They do not qualify a model or send the key.";
    render();
    void Promise.all([
      readResearchProviderKeyConfigurations(projectAtStart, generation, local.signal),
      readResearchProviderKeyModelSelection(projectAtStart, generation, local.signal),
    ]).then(async ([keys, currentSelection]) => {
      if (!requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) return;
      keyConfigurations = keys.configurations;
      selection = currentSelection;
      statusRead = true;
      if (recovery === undefined) recovery = readRecovery(projectAtStart);
      if (recovery !== undefined) {
        recoveryGenerationChanged = recovery.deployment_generation !== generation;
        if (!recoveryGenerationChanged) {
          try {
            await reconcileExact(mine, projectAtStart, generation, ownerAtStart, local.signal);
          } catch {
            if (requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) {
              currentSummary = "The exact check-and-use status could not be reconciled.";
              currentDetail = "The operation ID remains in this tab. Refresh its exact status; it will not be submitted again.";
              currentTone = "blocked";
            }
          }
        } else {
          currentSummary = "A saved check-and-use operation belongs to an earlier deployment.";
          currentDetail = "After verifying this owner and project, use the exact-status button to reconcile it. The page will not repeat the model action.";
          currentTone = "blocked";
        }
      } else {
        operation = undefined;
        readbackPending = false;
        selectionConfirmed = false;
        currentSummary = keys.configurations.some((item) => item.status === "configured_not_qualified")
          ? "A saved key is available for a separate check-and-use action."
          : "No confirmed saved OpenRouter key is available for a check-and-use action.";
        currentDetail = "The action checks the server's free-price gate and exact route qualification. A selected model changes only after matching server readback.";
        currentTone = keys.configurations.some((item) => item.status === "configured_not_qualified") ? "configured" : "unknown";
      }
    }).catch((error: unknown) => {
      if (!requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) return;
      statusRead = false;
      keyConfigurations = [];
      selection = undefined;
      const copy = errorCopy(error, "read");
      currentSummary = copy.summary;
      currentDetail = copy.detail;
      currentTone = "blocked";
    }).finally(() => {
      if (requestController === local) {
        requestController = undefined;
        busy = false;
        render();
      }
    });
  };

  const refreshExactStatus = (): void => {
    if (disposed || busy || recovery === undefined || !contextReady()) return;
    const generation = currentGeneration(options);
    const ownerAtStart = options.ownerSessionScopeEpoch();
    const projectAtStart = projectId;
    if (generation === undefined || ownerAtStart === undefined || projectAtStart === undefined) return;
    const mine = ++serial;
    const local = new AbortController();
    requestController = local;
    busy = true;
    currentSummary = "Reading the exact saved operation status…";
    currentDetail = "This GET reconciles one operation ID. It does not resubmit qualification or send the key.";
    render();
    void reconcileExact(mine, projectAtStart, generation, ownerAtStart, local.signal).catch((error: unknown) => {
      if (!requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) return;
      const copy = errorCopy(error, "status");
      currentSummary = copy.summary;
      currentDetail = copy.detail;
      currentTone = "blocked";
    }).finally(() => {
      if (requestController === local) {
        requestController = undefined;
        busy = false;
        render();
      }
    });
  };

  const start = (keyOperationId: string): void => {
    if (disposed || !canStart() || recovery !== undefined) return;
    const key = keyConfigurations.find((item) => item.operation_id === keyOperationId && item.status === "configured_not_qualified");
    if (key === undefined) return;
    const generation = currentGeneration(options);
    const ownerAtStart = options.ownerSessionScopeEpoch();
    const projectAtStart = projectId;
    if (generation === undefined || ownerAtStart === undefined || projectAtStart === undefined) return;
    const mine = ++serial;
    const local = new AbortController();
    requestController = local;
    busy = true;
    currentSummary = "Refreshing the selected model revision before this explicit action…";
    currentDetail = "This preflight is a safe GET. The key value is not read or passed to the model-use request.";
    render();
    void readResearchProviderKeyModelSelection(projectAtStart, generation, local.signal).then((currentSelection) => {
      if (!requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) return;
      selection = currentSelection;
      const operationId = crypto.randomUUID();
      const record = buildRecovery(projectAtStart, generation, operationId, key.operation_id);
      setRecovery(record);
      operation = undefined;
      readbackPending = false;
      selectionConfirmed = false;
      currentSummary = "Starting the explicit free-price and exact-route check…";
      currentDetail = "Only the saved key-operation ID and current selection revision are sent. No paid fallback is permitted.";
      render();
      return startResearchProviderKeyModelUse(projectAtStart, generation, key.operation_id,
        operationId, currentSelection.selection_revision, local.signal).then(async (result) => {
        if (!requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) return;
        await acceptOperation(result, mine, projectAtStart, generation, ownerAtStart, local.signal);
      });
    }).catch((error: unknown) => {
      if (!requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) return;
      if (recovery !== undefined && recovery.project_id === projectAtStart) {
        const copy = errorCopy(error, "start");
        operation = undefined;
        readbackPending = false;
        currentSummary = copy.summary;
        currentDetail = copy.detail;
        currentTone = "blocked";
      } else {
        const copy = errorCopy(error, "read");
        currentSummary = copy.summary;
        currentDetail = copy.detail;
        currentTone = "blocked";
      }
    }).finally(() => {
      if (requestController === local) {
        requestController = undefined;
        busy = false;
        render();
      }
    });
  };

  const onConfigurationListClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("[data-key-use-action]");
    const keyOperationId = button?.dataset.keyOperationId;
    if (keyOperationId !== undefined) start(keyOperationId);
  };

  const onProjectScopeChanged = (event: Event): void => {
    const detail = (event as CustomEvent<{ reason?: unknown; projectId?: unknown }>).detail;
    if (detail?.reason !== "project-filter") return;
    const nextProject = typeof detail.projectId === "string" && detail.projectId.length > 0 ? detail.projectId : undefined;
    if (nextProject === projectId) return;
    abortForContextChange();
    projectId = nextProject;
    keyConfigurations = [];
    selection = undefined;
    recovery = undefined;
    recoveryGenerationChanged = false;
    operation = undefined;
    statusRead = false;
    readbackPending = false;
    selectionConfirmed = false;
    storageUnavailable = false;
    currentSummary = nextProject === undefined ? "Select a project in Sources to check safe key and model status." : "Reading current project status…";
    currentDetail = "No key value or model configuration is sent by a status refresh.";
    currentTone = "unknown";
    if (contextReady()) refresh(); else render();
  };

  const onOwnerScopeChanged = (): void => {
    const next = options.ownerSessionScopeEpoch();
    if (next === ownerScopeEpoch) return;
    clearAllRecoveries();
    abortForContextChange();
    ownerScopeEpoch = next;
    keyConfigurations = [];
    selection = undefined;
    recovery = undefined;
    recoveryGenerationChanged = false;
    operation = undefined;
    statusRead = false;
    readbackPending = false;
    selectionConfirmed = false;
    storageUnavailable = false;
    currentSummary = "Owner session changed. Key and model-use status were cleared.";
    currentDetail = "Reverify the owner session before reading or starting an operation.";
    currentTone = "blocked";
    if (contextReady()) refresh(); else render();
  };

  const onAuthorizationCleared = (): void => {
    clearAllRecoveries();
    clearPrivate("Owner authorization changed. Key and model-use status were cleared.");
  };
  const onHealthLost = (): void => clearPrivate("Server connection changed. Key and model-use status were cleared.");
  const onHealthUpdated = (): void => {
    if (options.healthReady() && projectId !== undefined && ownerScopeEpoch !== undefined) refresh();
    else render();
  };
  const onOffline = (): void => clearPrivate("Offline. Key and model-use status were cleared from the page.");
  const onOnline = (): void => { if (contextReady()) refresh(); else render(); };
  const onKeyConfigurationChanged = (event: Event): void => {
    const detail = (event as CustomEvent<{ projectId?: unknown }>).detail;
    if (detail?.projectId === projectId) refresh();
  };

  refreshButton.addEventListener("click", refresh);
  statusButton.addEventListener("click", refreshExactStatus);
  configurationsHost.addEventListener("click", onConfigurationListClick);
  document.addEventListener("library:scope-changed", onProjectScopeChanged);
  app?.addEventListener("eliotr:owner-session-scope-changed", onOwnerScopeChanged);
  app?.addEventListener("eliotr:health-lost", onHealthLost);
  app?.addEventListener("eliotr:health-updated", onHealthUpdated);
  app?.addEventListener("eliotr:provider-key-configurations-changed", onKeyConfigurationChanged);
  window.addEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  render();

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    abortForContextChange();
    refreshButton.removeEventListener("click", refresh);
    statusButton.removeEventListener("click", refreshExactStatus);
    configurationsHost.removeEventListener("click", onConfigurationListClick);
    document.removeEventListener("library:scope-changed", onProjectScopeChanged);
    app?.removeEventListener("eliotr:owner-session-scope-changed", onOwnerScopeChanged);
    app?.removeEventListener("eliotr:health-lost", onHealthLost);
    app?.removeEventListener("eliotr:health-updated", onHealthUpdated);
    app?.removeEventListener("eliotr:provider-key-configurations-changed", onKeyConfigurationChanged);
    window.removeEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("pagehide", cleanup);
    element.replaceChildren();
  };
  window.addEventListener("pagehide", cleanup, { once: true });
  return Object.assign(cleanup, { clearPrivate, refresh });
}
