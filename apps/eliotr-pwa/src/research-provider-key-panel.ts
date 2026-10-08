import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import {
  configureResearchProviderKey,
  isResearchProviderKeyInputValid,
  readResearchProviderKeyConfigurations,
  type ResearchProviderKeyConfiguration,
  type ResearchProviderKeyConfigurationReceipt,
} from "./research-provider-key-api.js";

export interface ResearchProviderKeyPanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
  /** Monotonic, non-identifying epoch for the current verified owner session. */
  readonly ownerSessionScopeEpoch: () => number | undefined;
}

export type ResearchProviderKeyCopy = Readonly<{ summary: string; explanation: string }>;

type RequestAction = "read" | "write";

function currentGeneration(options: ResearchProviderKeyPanelOptions): string | undefined {
  const value = options.deploymentGeneration();
  return value === undefined || value === "" || value === "unreachable" ? undefined : value;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function researchProviderKeyErrorCopy(error: unknown, action: RequestAction): ResearchProviderKeyCopy {
  if (error instanceof ApiRequestError) {
    if (isAuthorizationLoss(error)) return {
      summary: "Sign in again to manage this project's OpenRouter key.",
      explanation: "The current owner session could not read or update provider-key settings.",
    };
    if (error.code === "RESEARCH_PROVIDER_KEY_CONFIGURATION_OWNER_REQUIRED") return {
      summary: "Verify the current owner session before managing provider keys.",
      explanation: "This project operation requires a directly authenticated owner session.",
    };
    if (error.code === "RESEARCH_PROVIDER_KEY_CONFIGURATION_CSRF_DENIED") return {
      summary: "The key change was rejected by same-origin request protection.",
      explanation: "Reload the workspace and try again. The page will not resend the key automatically.",
    };
    if (error.code === "RESEARCH_PROVIDER_KEY_CONFIGURATION_PROJECT_NOT_FOUND") return {
      summary: "This project is no longer available to the current owner.",
      explanation: "Select a currently authorized project in Sources, then read its key status again.",
    };
    if (error.code === "RESEARCH_PROVIDER_KEY_CONFIGURATION_AUTHORITY_CHANGED") return {
      summary: "Project authority changed during the key operation.",
      explanation: "Refresh the selected project and read its current safe status before continuing.",
    };
    if (error.code === "RESEARCH_PROVIDER_KEY_CONFIGURATION_MANAGEMENT_UNAVAILABLE") return {
      summary: "OpenRouter key management is not available on this server.",
      explanation: "Ask an administrator to configure the server-side management connection. No model was called.",
    };
    if (error.code === "RESEARCH_PROVIDER_KEY_CONFIGURATION_PROVIDER_REJECTED") return {
      summary: "The server reports that this key operation was not written.",
      explanation: "Refresh the exact operation status to confirm. Do not resend this operation; a new one is available only after the server records `not_configured`.",
    };
    if (error.code === "API_GENERATION_MISMATCH") return {
      summary: "The deployment changed during the key request.",
      explanation: action === "write" ? "Refresh safe key status before deciding whether to start a new operation; the key was not resent." : "Refresh the server check, then read provider-key status again.",
    };
    if (error.code === "RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID" || error.status === 413 || error.status === 415) return {
      summary: action === "write" ? "The key request did not meet the server's input requirements." : "The status request was not accepted.",
      explanation: "Check the key length and request format, then read current status before trying again.",
    };
    if (error.code === "RESEARCH_PROVIDER_KEY_CONFIGURATION_OPERATION_CONFLICT") return {
      summary: "This key operation conflicts with an earlier request.",
      explanation: "Refresh safe key status. Start a new operation only after the earlier result is understood.",
    };
    if (error.code === "RESEARCH_PROVIDER_KEY_CONFIGURATION_OPERATION_IN_PROGRESS") return {
      summary: "This key operation is still in progress.",
      explanation: "Refresh safe key status before starting another operation. The PWA does not resend a key automatically.",
    };
    if (error.code === "RESEARCH_PROVIDER_KEY_CONFIGURATION_OUTCOME_UNKNOWN") return {
      summary: "The server could not confirm the OpenRouter key result.",
      explanation: "The write may have reached the provider. Refresh safe key status or ask an administrator to reconcile it; no automatic retry was sent.",
    };
    if (error.status === 403) return {
      summary: "Provider-key management is not authorized for this session.",
      explanation: "The active session can reach the owner API, but current server policy does not permit this key operation.",
    };
    if (error.status === 404) return {
      summary: "OpenRouter key management is unavailable for this project.",
      explanation: "The server did not expose this provider-key operation. No model was contacted.",
    };
    if (error.status === 409) return {
      summary: "A provider-key operation is pending or conflicts with an earlier request.",
      explanation: "Refresh key status before starting another operation. The PWA does not resend a key automatically.",
    };
    if (action === "write" && (error.status >= 500 || error.code === "API_UNREACHABLE" ||
        error.code === "API_REQUEST_ABORTED" || error.retryable)) return {
      summary: "The server could not confirm the OpenRouter key result.",
      explanation: "The write may have reached the server. Refresh safe key status before deciding whether to start a new operation; no automatic retry was sent.",
    };
    if (error.code === "API_UNREACHABLE" || error.code === "API_REQUEST_ABORTED" || error.code === "API_HTTP_UNAVAILABLE") return {
      summary: "OpenRouter key status is unavailable.",
      explanation: "Check the server connection, then refresh the safe status list. No model was contacted.",
    };
  }
  return {
    summary: action === "write" ? "The OpenRouter key could not be saved." : "OpenRouter key status could not be read.",
    explanation: "Check the server connection and current access policy, then read key status again.",
  };
}

function statusLabel(status: ResearchProviderKeyConfiguration["status"]): string {
  if (status === "configured_not_qualified") return "Stored; model not qualified";
  if (status === "pending") return "Setup pending";
  if (status === "not_configured") return "Not saved; no provider key was written";
  return "Outcome unknown; check status before another operation";
}

function notConfiguredCopy(configuration: ResearchProviderKeyConfiguration): ResearchProviderKeyCopy {
  switch (configuration.failure_code) {
    case "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID": return {
      summary: "The server-side provider credential check failed before the key was written.",
      explanation: "Ask an administrator to verify the server's provider-management connection, then start a new operation if needed.",
    };
    case "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED": return {
      summary: "Provider-key preflight did not pass; this key was not written.",
      explanation: "This operation is confirmed as not configured. Check for any other unresolved key operation before submitting another key.",
    };
    case "OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT": return {
      summary: "The provider-key operation could not use its requested configuration.",
      explanation: "No existing provider configuration was adopted. This operation is confirmed as not configured; check for other unresolved operations before submitting again.",
    };
    case "OPENROUTER_PROVIDER_KEY_INPUT_INVALID": return {
      summary: "The provider rejected the key input before saving it.",
      explanation: "This operation is confirmed as not configured. Check the entered key, then refresh status before submitting again.",
    };
    default: return {
      summary: "This provider-key operation is confirmed as not configured.",
      explanation: "No key was written by this operation. Read status again before continuing.",
    };
  }
}

function timestampLabel(value: string): string {
  return value;
}

export function mountResearchProviderKeyPanel(
  element: HTMLElement,
  options: ResearchProviderKeyPanelOptions,
): (() => void) & { clearPrivate(message?: string): void; refresh(): void } {
  element.innerHTML = `<section class="research-provider-key-panel" aria-labelledby="research-provider-key-title">
    <div class="connection-heading"><div><span class="eyebrow">Research provider</span><h3 id="research-provider-key-title">OpenRouter key</h3></div><span class="connection-state connection-state--unknown" data-provider-key-badge>NOT CHECKED</span></div>
    <p data-provider-key-summary role="status" aria-live="polite">Select a project in Sources to inspect its OpenRouter key status.</p>
    <p data-provider-key-explanation>Saving a key does not qualify or select a model. Existing configurations and started runs stay unchanged.</p>
    <form data-provider-key-form novalidate>
      <label for="research-provider-key-input">New OpenRouter key</label>
      <input id="research-provider-key-input" type="password" autocomplete="new-password" minlength="16" maxlength="4096" spellcheck="false" data-1p-ignore data-lpignore="true" aria-describedby="research-provider-key-help" disabled />
      <p id="research-provider-key-help" class="connection-note">The key is sent once to the owner API and is never returned to this page.</p>
      <p class="connection-note" data-provider-key-history-warning role="status" aria-live="polite" hidden></p>
      <label class="connection-note" data-provider-key-new-operation-ack hidden><input type="checkbox" data-provider-key-ack /> I understand that saving now creates a separate operation; it does not retry or resolve any earlier pending or unknown result.</label>
      <div class="connection-actions"><button class="button button--quiet" type="submit" data-provider-key-save disabled>Save key</button><button class="button button--quiet" type="button" data-provider-key-refresh disabled>Refresh key status</button></div>
    </form>
    <ul data-provider-key-configurations aria-label="OpenRouter key status history"></ul>
    <p class="connection-note" data-provider-key-truncated hidden>Only the newest 50 key-operation statuses are available here.</p>
  </section>`;

  const root = element.querySelector<HTMLElement>(".research-provider-key-panel");
  const badge = root?.querySelector<HTMLElement>("[data-provider-key-badge]");
  const summary = root?.querySelector<HTMLElement>("[data-provider-key-summary]");
  const explanation = root?.querySelector<HTMLElement>("[data-provider-key-explanation]");
  const form = root?.querySelector<HTMLFormElement>("[data-provider-key-form]");
  const keyInput = root?.querySelector<HTMLInputElement>("#research-provider-key-input");
  const saveButton = root?.querySelector<HTMLButtonElement>("[data-provider-key-save]");
  const refreshButton = root?.querySelector<HTMLButtonElement>("[data-provider-key-refresh]");
  const configurationsHost = root?.querySelector<HTMLUListElement>("[data-provider-key-configurations]");
  const truncated = root?.querySelector<HTMLElement>("[data-provider-key-truncated]");
  const historyWarning = root?.querySelector<HTMLElement>("[data-provider-key-history-warning]");
  const acknowledgement = root?.querySelector<HTMLInputElement>("[data-provider-key-ack]");
  const acknowledgementLabel = root?.querySelector<HTMLElement>("[data-provider-key-new-operation-ack]");
  if (!root || !badge || !summary || !explanation || !form || !keyInput || !saveButton || !refreshButton ||
      !configurationsHost || !truncated || !historyWarning || !acknowledgement || !acknowledgementLabel) {
    throw new Error("OpenRouter key panel is incomplete");
  }

  const app = element.closest<HTMLElement>("#app");
  let disposed = false;
  let serial = 0;
  let projectId: string | undefined;
  let ownerScopeEpoch = options.ownerSessionScopeEpoch();
  let readController: AbortController | undefined;
  let writeController: AbortController | undefined;
  let loading = false;
  let saving = false;
  let statusRead = false;
  let configurations: readonly ResearchProviderKeyConfiguration[] = [];
  let truncatedPage = false;
  let unresolvedOperationIds: string[] = [];
  let unresolvedIdsTruncated = false;
  let lastOperationId: string | undefined;
  let uncertainOperation = false;
  let receipt: ResearchProviderKeyConfigurationReceipt | undefined;
  let notice: ResearchProviderKeyCopy | undefined;
  let noticeTone: "unknown" | "pending" | "configured" | "blocked" = "unknown";

  const contextReady = (): boolean => projectId !== undefined && options.healthReady() && isOnline() &&
    currentGeneration(options) !== undefined && ownerScopeEpoch !== undefined &&
    options.ownerSessionScopeEpoch() === ownerScopeEpoch;
  const unresolvedConfigurations = (): readonly ResearchProviderKeyConfiguration[] => configurations.filter((item) =>
    item.status === "pending" || item.status === "outcome_unknown");
  const addUnresolvedOperation = (operationId: string): void => {
    if (unresolvedOperationIds.includes(operationId)) return;
    unresolvedOperationIds = [...unresolvedOperationIds, operationId];
    if (unresolvedOperationIds.length > 50) {
      unresolvedOperationIds = unresolvedOperationIds.slice(-50);
      unresolvedIdsTruncated = true;
    }
  };
  const removeUnresolvedOperation = (operationId: string): void => {
    unresolvedOperationIds = unresolvedOperationIds.filter((item) => item !== operationId);
  };
  const needsAcknowledgement = (): boolean => uncertainOperation || unresolvedOperationIds.length > 0 ||
    truncatedPage || unresolvedIdsTruncated || unresolvedConfigurations().length > 0;
  const historyWarningText = (): string => {
    const unresolved = new Set([
      ...unresolvedOperationIds,
      ...unresolvedConfigurations().map((item) => item.operation_id),
    ]);
    if (lastOperationId !== undefined) unresolved.delete(lastOperationId);
    const messages: string[] = [];
    if (uncertainOperation) messages.push("The latest submitted operation is unconfirmed. It will not be resent, and a new submission will not resolve it.");
    if (unresolved.size > 0) messages.push(`${unresolved.size} earlier operation${unresolved.size === 1 ? " remains" : "s remain"} pending or unknown.`);
    if (truncatedPage || unresolvedIdsTruncated) messages.push("Some older operation records are outside the displayed history, so their outcomes are not known here.");
    return messages.join(" ");
  };
  const mergeOperationPage = (page: readonly ResearchProviderKeyConfiguration[]): void => {
    const merged = new Map(configurations.map((item) => [item.operation_id, item]));
    for (const item of page) merged.set(item.operation_id, item);
    const ordered = [...merged.values()].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
    if (ordered.length > 50) truncatedPage = true;
    configurations = ordered.slice(0, 50);
  };
  const updateBadge = (text: string, tone: "unknown" | "pending" | "configured" | "blocked"): void => {
    badge.className = `connection-state connection-state--${tone}`;
    badge.textContent = text;
  };
  const renderConfigurations = (): void => {
    configurationsHost.replaceChildren();
    for (const item of configurations) {
      const entry = document.createElement("li");
      const state = document.createElement("strong");
      state.textContent = item.status === "not_configured" ? notConfiguredCopy(item).summary : statusLabel(item.status);
      const date = document.createElement("time");
      date.dateTime = item.updated_at;
      date.textContent = ` · ${timestampLabel(item.updated_at)}`;
      entry.append(state, date);
      if (item.provider_http_status !== null) {
        const providerStatus = document.createElement("span");
        providerStatus.textContent = ` · Provider HTTP ${item.provider_http_status}`;
        entry.append(providerStatus);
      }
      configurationsHost.append(entry);
    }
    truncated.hidden = !truncatedPage;
  };
  const render = (): void => {
    const ready = contextReady();
    if (projectId === undefined) {
      updateBadge("PROJECT REQUIRED", "blocked");
      summary.textContent = "Select a project in Sources to inspect its OpenRouter key status.";
      explanation.textContent = "Provider keys are managed within the selected project. No request was sent.";
    } else if (!options.healthReady() || !isOnline() || currentGeneration(options) === undefined) {
      updateBadge("SERVER UNAVAILABLE", "blocked");
      summary.textContent = isOnline() ? "The owner API is not ready for provider-key settings." : "Offline. Provider-key settings are not cached.";
      explanation.textContent = "Reconnect and verify the owner session before reading or saving key settings.";
    } else if (ownerScopeEpoch === undefined || options.ownerSessionScopeEpoch() !== ownerScopeEpoch) {
      updateBadge("OWNER SESSION REQUIRED", "blocked");
      summary.textContent = "Verify the current owner session before managing provider keys.";
      explanation.textContent = "The key page is cleared when the verified owner session changes.";
    } else if (loading) {
      updateBadge("CHECKING", "pending");
      summary.textContent = "Reading safe OpenRouter key status…";
      explanation.textContent = "The key value is never returned by the status endpoint.";
    } else if (saving) {
      updateBadge("SAVING", "pending");
      summary.textContent = "Sending the key once to the owner API…";
      explanation.textContent = "The input is cleared. This operation is not automatically retried.";
    } else if (uncertainOperation) {
      updateBadge("CHECK STATUS", "blocked");
      summary.textContent = notice?.summary ?? "A key operation has not been confirmed.";
      explanation.textContent = notice?.explanation ?? "Refresh safe key status. Any new submission is a separate operation and will not resolve this one.";
    } else if (notice !== undefined) {
      updateBadge(noticeTone === "configured" ? "STORED · NOT QUALIFIED" : noticeTone === "blocked" ? "UNAVAILABLE" : "STATUS READ", noticeTone);
      summary.textContent = notice.summary;
      explanation.textContent = notice.explanation;
    } else if (receipt !== undefined) {
      updateBadge("STORED · NOT QUALIFIED", "configured");
      summary.textContent = "Ключ сохранён. Проверьте модель, чтобы использовать его в новых исследованиях.";
      explanation.textContent = "Текущая модель и уже начатые исследования не изменились. Для новых исследований нужна отдельная квалификация и выбор точной конфигурации.";
    } else if (configurations.length === 0 && !truncatedPage) {
      updateBadge("NO RECORDED KEY", "unknown");
      summary.textContent = "No OpenRouter key operation is recorded for this project.";
      explanation.textContent = "Only key operations recorded through this project control appear here. Saving a key does not qualify or select a model.";
    } else {
      updateBadge("STATUS READ", "unknown");
      summary.textContent = "OpenRouter key status was read from the current server.";
      explanation.textContent = "Only the server can confirm provider-key configuration. Model qualification and selection are separate.";
    }
    const canWrite = ready && statusRead && !loading && !saving;
    const acknowledgmentRequired = needsAcknowledgement();
    historyWarning.hidden = !acknowledgmentRequired;
    historyWarning.textContent = acknowledgmentRequired ? historyWarningText() : "";
    acknowledgementLabel.hidden = !acknowledgmentRequired;
    acknowledgement.disabled = !ready || loading || saving;
    if (!acknowledgmentRequired) acknowledgement.checked = false;
    keyInput.disabled = !canWrite;
    saveButton.textContent = acknowledgmentRequired && acknowledgement.checked ? "Save as a separate operation" : "Save key";
    saveButton.disabled = !canWrite || !isResearchProviderKeyInputValid(keyInput.value) ||
      (acknowledgmentRequired && !acknowledgement.checked);
    refreshButton.disabled = !ready || loading || saving;
    form.setAttribute("aria-busy", saving ? "true" : "false");
    renderConfigurations();
  };
  const clearReadState = (): void => {
    statusRead = false;
    configurations = [];
    truncatedPage = false;
    unresolvedOperationIds = [];
    unresolvedIdsTruncated = false;
    acknowledgement.checked = false;
    receipt = undefined;
    lastOperationId = undefined;
    uncertainOperation = false;
    notice = undefined;
    noticeTone = "unknown";
    renderConfigurations();
  };
  const abortRequests = (): void => {
    serial += 1;
    readController?.abort();
    readController = undefined;
    writeController?.abort();
    writeController = undefined;
    loading = false;
    saving = false;
  };
  const clearPrivate = (message = "Provider-key status cleared."): void => {
    abortRequests();
    keyInput.value = "";
    clearReadState();
    notice = { summary: message, explanation: "Read current key status again when the project, owner session, and server are ready." };
    noticeTone = "blocked";
    render();
  };
  const requestStillCurrent = (mine: number, projectAtStart: string, generationAtStart: string,
    ownerAtStart: number): boolean => mine === serial && !disposed && projectId === projectAtStart &&
    currentGeneration(options) === generationAtStart && options.ownerSessionScopeEpoch() === ownerAtStart &&
    ownerScopeEpoch === ownerAtStart && options.healthReady() && isOnline();

  const refresh = (): void => {
    if (disposed || loading || saving) return;
    keyInput.value = "";
    acknowledgement.checked = false;
    const generation = currentGeneration(options);
    const ownerAtStart = options.ownerSessionScopeEpoch();
    if (projectId === undefined || generation === undefined || ownerAtStart === undefined ||
        ownerAtStart !== ownerScopeEpoch || !options.healthReady() || !isOnline()) {
      render();
      return;
    }
    const projectAtStart = projectId;
    const operationIdAtStart = lastOperationId;
    const mine = ++serial;
    const local = new AbortController();
    readController = local;
    loading = true;
    statusRead = false;
    notice = undefined;
    render();
    void readResearchProviderKeyConfigurations(projectAtStart, generation, local.signal, operationIdAtStart).then((page) => {
      if (!requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) return;
      if (operationIdAtStart === undefined) {
        configurations = page.configurations;
        truncatedPage = page.truncated;
        uncertainOperation = false;
        for (const item of page.configurations) {
          if (item.status === "pending" || item.status === "outcome_unknown") addUnresolvedOperation(item.operation_id);
          else removeUnresolvedOperation(item.operation_id);
        }
      } else {
        mergeOperationPage(page.configurations);
      }
      statusRead = true;
      if (operationIdAtStart !== undefined) {
        const operation = page.configurations.find((item) => item.operation_id === operationIdAtStart);
        if (operation?.status === "configured_not_qualified") {
          uncertainOperation = false;
          removeUnresolvedOperation(operationIdAtStart);
          receipt = undefined;
          notice = { summary: "The OpenRouter key operation is recorded by the server.", explanation: "It remains unqualified and has not changed the selected model or any started run." };
          noticeTone = "configured";
          lastOperationId = undefined;
        } else if (operation?.status === "not_configured") {
          uncertainOperation = false;
          removeUnresolvedOperation(operationIdAtStart);
          receipt = undefined;
          notice = notConfiguredCopy(operation);
          noticeTone = "blocked";
          lastOperationId = undefined;
        } else if (operation !== undefined) {
          uncertainOperation = true;
          addUnresolvedOperation(operationIdAtStart);
          notice = { summary: statusLabel(operation.status), explanation: "No key was resent. This operation remains unresolved; a new operation requires separate acknowledgment." };
          noticeTone = operation.status === "pending" ? "pending" : "blocked";
        } else {
          uncertainOperation = true;
          addUnresolvedOperation(operationIdAtStart);
          notice = { summary: "This specific key operation is absent from the status response.", explanation: "Its result remains unconfirmed. It will not be resent; any new submission is a separate operation." };
          noticeTone = "blocked";
        }
      }
      if (notice === undefined) {
        notice = page.configurations.length === 0 && !page.truncated
          ? { summary: "No OpenRouter key operation is recorded for this project.", explanation: "Only key operations recorded through this project control appear here. Saving a key does not qualify or select a model." }
          : { summary: "OpenRouter key status was read from the current server.", explanation: "Only the server can confirm provider-key configuration. Model qualification and selection are separate." };
        noticeTone = "unknown";
      }
    }).catch((error: unknown) => {
      if (!requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) return;
      configurations = [];
      truncatedPage = false;
      statusRead = false;
      notice = researchProviderKeyErrorCopy(error, "read");
      noticeTone = "blocked";
    }).finally(() => {
      if (readController === local) {
        readController = undefined;
        loading = false;
        render();
      }
    });
  };

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const providerKey = keyInput.value;
    keyInput.value = "";
    if (!isResearchProviderKeyInputValid(providerKey)) {
      notice = { summary: "Enter a valid OpenRouter key.", explanation: "The key must contain 16 to 4096 visible ASCII characters. The entered value was cleared." };
      noticeTone = "blocked";
      render();
      return;
    }
    if (!contextReady() || loading || saving || !statusRead || (needsAcknowledgement() && !acknowledgement.checked)) {
      notice = needsAcknowledgement() && !acknowledgement.checked
        ? { summary: "Acknowledge that this is a separate key operation.", explanation: "Earlier pending or unknown results remain unresolved. This submission will use a new operation ID and will not retry or resolve them." }
        : { summary: "OpenRouter key settings are not ready.", explanation: "Refresh status after verifying the selected project, owner session, and server." };
      noticeTone = "blocked";
      render();
      return;
    }
    const generation = currentGeneration(options);
    const ownerAtStart = options.ownerSessionScopeEpoch();
    const projectAtStart = projectId;
    if (generation === undefined || ownerAtStart === undefined || projectAtStart === undefined) {
      render();
      return;
    }
    const operationId = crypto.randomUUID();
    if (uncertainOperation && lastOperationId !== undefined) addUnresolvedOperation(lastOperationId);
    lastOperationId = operationId;
    addUnresolvedOperation(operationId);
    acknowledgement.checked = false;
    const mine = ++serial;
    const local = new AbortController();
    writeController = local;
    saving = true;
    uncertainOperation = true;
    notice = undefined;
    const pending = configureResearchProviderKey(projectAtStart, generation, operationId, providerKey, local.signal);
    render();
    void pending.then((saved) => {
      if (!requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) return;
      receipt = saved;
      statusRead = true;
      uncertainOperation = false;
      removeUnresolvedOperation(operationId);
      notice = { summary: "Ключ сохранён. Проверьте модель, чтобы использовать его в новых исследованиях.", explanation: "Текущая модель и уже начатые исследования не изменились. Для новых исследований нужна отдельная квалификация и выбор точной конфигурации." };
      noticeTone = "configured";
      app?.dispatchEvent(new CustomEvent("eliotr:provider-key-configurations-changed", { detail: { projectId: projectAtStart } }));
    }).catch((error: unknown) => {
      if (!requestStillCurrent(mine, projectAtStart, generation, ownerAtStart)) return;
      notice = researchProviderKeyErrorCopy(error, "write");
      noticeTone = "blocked";
      uncertainOperation = error instanceof ApiRequestError &&
        error.code !== "RESEARCH_PROVIDER_KEY_CONFIGURATION_OWNER_REQUIRED" &&
        error.code !== "RESEARCH_PROVIDER_KEY_CONFIGURATION_PROJECT_NOT_FOUND" &&
        error.code !== "RESEARCH_PROVIDER_KEY_CONFIGURATION_CSRF_DENIED" &&
        error.code !== "RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID" &&
        error.code !== "RESEARCH_PROVIDER_KEY_CONFIGURATION_MANAGEMENT_UNAVAILABLE" &&
        (error.status >= 500 || error.status === 409 || error.retryable || error.code === "API_REQUEST_ABORTED" ||
          error.code === "API_UNREACHABLE" || error.code === "API_HTTP_UNAVAILABLE");
      if (uncertainOperation) addUnresolvedOperation(operationId);
      else {
        removeUnresolvedOperation(operationId);
        if (lastOperationId === operationId) lastOperationId = undefined;
      }
    }).finally(() => {
      if (writeController === local) {
        writeController = undefined;
        saving = false;
        render();
      }
    });
  };

  const onProjectScopeChanged = (event: Event): void => {
    const detail = (event as CustomEvent<{ reason?: unknown; projectId?: unknown }>).detail;
    if (detail?.reason !== "project-filter") return;
    const nextProjectId = typeof detail.projectId === "string" && detail.projectId.length > 0 ? detail.projectId : undefined;
    if (nextProjectId === projectId) return;
    projectId = nextProjectId;
    abortRequests();
    keyInput.value = "";
    clearReadState();
    if (projectId === undefined) {
      notice = { summary: "Select a project in Sources to inspect its OpenRouter key status.", explanation: "No request was sent." };
      noticeTone = "blocked";
      render();
    } else {
      refresh();
    }
  };
  const onOwnerScopeChanged = (): void => {
    const next = options.ownerSessionScopeEpoch();
    if (next === ownerScopeEpoch) return;
    ownerScopeEpoch = next;
    abortRequests();
    keyInput.value = "";
    clearReadState();
    if (ownerScopeEpoch !== undefined && projectId !== undefined) refresh();
    else {
      notice = { summary: "Owner session changed. Provider-key status was cleared.", explanation: "Verify the current owner session before reading or saving provider-key settings." };
      noticeTone = "blocked";
      render();
    }
  };
  const onHealthLost = (): void => clearPrivate("Server connection changed. Provider-key status was cleared.");
  const onHealthUpdated = (): void => {
    if (options.healthReady() && projectId !== undefined && ownerScopeEpoch !== undefined) refresh();
    else render();
  };
  const onOffline = (): void => clearPrivate("Offline. Provider-key status and input were cleared.");
  const onOnline = (): void => {
    if (projectId !== undefined && ownerScopeEpoch !== undefined && options.healthReady()) refresh();
    else render();
  };

  form.addEventListener("submit", onSubmit);
  keyInput.addEventListener("input", render);
  acknowledgement.addEventListener("change", render);
  refreshButton.addEventListener("click", refresh);
  document.addEventListener("library:scope-changed", onProjectScopeChanged);
  app?.addEventListener("eliotr:owner-session-scope-changed", onOwnerScopeChanged);
  app?.addEventListener("eliotr:health-lost", onHealthLost);
  app?.addEventListener("eliotr:health-updated", onHealthUpdated);
  window.addEventListener("eliotr:authorization-cleared", onHealthLost);
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  render();

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    abortRequests();
    keyInput.value = "";
    form.removeEventListener("submit", onSubmit);
    keyInput.removeEventListener("input", render);
    acknowledgement.removeEventListener("change", render);
    refreshButton.removeEventListener("click", refresh);
    document.removeEventListener("library:scope-changed", onProjectScopeChanged);
    app?.removeEventListener("eliotr:owner-session-scope-changed", onOwnerScopeChanged);
    app?.removeEventListener("eliotr:health-lost", onHealthLost);
    app?.removeEventListener("eliotr:health-updated", onHealthUpdated);
    window.removeEventListener("eliotr:authorization-cleared", onHealthLost);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("pagehide", cleanup);
    element.replaceChildren();
  };
  window.addEventListener("pagehide", cleanup, { once: true });
  return Object.assign(cleanup, { clearPrivate, refresh });
}
