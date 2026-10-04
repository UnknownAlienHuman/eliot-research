import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import {
  mountResearchModelConfigurationPanel,
  RESEARCH_MODEL_SELECTION_SAVED_EVENT,
} from "./research-model-configuration-panel.js";
import {
  readResearchConfiguration,
  type ResearchConfigurationState,
  type ResearchConfigurationView,
  type ResearchRunReadiness,
  type ResearchModelTransport,
} from "./research-configuration-api.js";

export type ResearchConfigurationStartState = {
  readonly configuration: ResearchConfigurationState;
  readonly model_transport: ResearchModelTransport;
  readonly qualification_state: ResearchConfigurationView["qualification_state"];
  readonly run_readiness: ResearchRunReadiness;
};

export const NO_PROJECT_RESEARCH_START_STATE: Readonly<ResearchConfigurationStartState> = Object.freeze({
  configuration: "missing",
  model_transport: "unavailable",
  qualification_state: "unavailable",
  run_readiness: "blocked",
});

export const NO_PROJECT_RESEARCH_COPY: ResearchConfigurationCopy = Object.freeze({
  summary: "Select a project before starting new research.",
  explanation: "Readiness is checked for the selected project. Existing runs and saved drafts remain available below.",
});

export interface ResearchConfigurationPanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly onStateChange?: (state: ResearchConfigurationStartState | null) => void;
}

function stateClass(view: ResearchConfigurationView): string {
  return view.configuration === "present" && view.run_readiness !== "blocked" ? "configured" : "blocked";
}

function stateLabel(view: ResearchConfigurationView): string {
  if (view.configuration === "missing") return "NOT CONFIGURED";
  if (view.configuration === "invalid") return "NEEDS ATTENTION";
  if (view.run_readiness === "blocked") return "START BLOCKED";
  if (view.run_readiness === "lazy_renewal") return "READY · RENEWAL AT RUN";
  return "READY TO RUN";
}

function qualificationLabel(value: ResearchConfigurationView["qualification_state"]): string {
  if (value === "current") return "Current";
  if (value === "renewal_required") return "Renewal required";
  return "Unavailable";
}

function readinessLabel(value: ResearchRunReadiness): string {
  if (value === "ready") return "Ready";
  if (value === "lazy_renewal") return "Ready; renews at run";
  return "Blocked";
}

function expiryLabel(value: string | null): string {
  return value === null ? "Unavailable" : value;
}

export interface ResearchConfigurationCopy {
  readonly summary: string;
  readonly explanation: string;
}

export function researchConfigurationErrorCopy(error: unknown): ResearchConfigurationCopy {
  if (error instanceof ApiRequestError) {
    if (error.code === "API_RESPONSE_SCHEMA_MISMATCH" || error.code === "MALFORMED_JSON_RESPONSE" ||
        error.code === "MALFORMED_API_PROBLEM" || error.code === "API_RESPONSE_TOO_LARGE" ||
        error.code === "API_STATUS_INVALID") {
      return {
        summary: "The server returned an invalid configuration response.",
        explanation: "Run readiness could not be established from this response. Check the server and PWA versions, then refresh this panel.",
      };
    }
    if (isAuthorizationLoss(error)) {
      return {
        summary: "Sign in again to check research configuration.",
        explanation: "The current owner session cannot read this configuration.",
      };
    }
    if (error.status === 403) {
      return {
        summary: "Research configuration is denied by the current access policy.",
        explanation: "The owner session is still active, but its current policy does not allow this configuration read. Ask an administrator to review the Research read policy.",
      };
    }
    if (error.code === "SCHEMA_NOT_READY") {
      return {
        summary: "The server is still starting.",
        explanation: "Check the server again before reading research configuration.",
      };
    }
    if (error.code === "API_UNREACHABLE" || error.code === "API_REQUEST_ABORTED") {
      return {
        summary: "Research configuration is unavailable.",
        explanation: "Check the server connection, then refresh this panel.",
      };
    }
    if (error.status >= 500) {
      return {
        summary: "The server could not check research configuration.",
        explanation: "No run readiness was confirmed. Check the server configuration and bindings, then refresh this panel.",
      };
    }
    if (error.retryable) {
      return {
        summary: "Research configuration could not be confirmed.",
        explanation: "The workspace changed or the check was interrupted. Refresh this panel to read the current configuration.",
      };
    }
  }
  return {
    summary: "Research configuration could not be read.",
    explanation: "Refresh this panel after checking the server connection.",
  };
}

export function researchConfigurationViewCopy(view: ResearchConfigurationView): ResearchConfigurationCopy {
  if (view.configuration === "missing") {
    return {
      summary: "Research agents are not configured.",
      explanation: "Research cannot start until the server has a research model configuration. Add it on the server, then refresh this panel.",
    };
  }
  if (view.configuration === "invalid") {
    return {
      summary: "Research configuration needs attention.",
      explanation: "The server found settings it cannot use. Correct the listed settings, then refresh this panel.",
    };
  }
  if (view.model_transport === "available" && view.run_readiness === "ready") {
    return {
      summary: "Research is ready to start with current qualification proofs.",
      explanation: "The server read the installed model route and current proofs. This panel does not contact the model provider.",
    };
  }
  if (view.run_readiness === "lazy_renewal") {
    return {
      summary: "Research can start; access will renew when the run starts.",
      explanation: "Qualification is due for renewal. The server will renew it lazily at run time; this panel does not verify a live provider connection.",
    };
  }
  if (view.readiness_reason === "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED") {
    return {
      summary: "Qualification proofs need renewal before research can start.",
      explanation: "The required server Read token is missing. An administrator must install it, then refresh this panel.",
    };
  }
  if (view.qualification_state === "unavailable") {
    return {
      summary: "Research readiness could not be established.",
      explanation: "The server could not read current qualification proofs. Check server configuration and database availability, then refresh this panel.",
    };
  }
  if (view.model_transport === "available") {
    return {
      summary: "Research is not ready to start.",
      explanation: "The server reported a readiness blocker. Correct the reported configuration or qualification issue, then refresh this panel.",
    };
  }
  return {
    summary: "Research configuration is installed, but its model transport is unavailable.",
    explanation: "Configuration alone does not confirm a live research run. Check the server and its model binding, then refresh this panel.",
  };
}

export function mountResearchConfigurationPanel(
  element: HTMLElement,
  options: ResearchConfigurationPanelOptions,
): (() => void) & { clearPrivate(message?: string): void; refresh(): void } {
  element.innerHTML = `<div class="research-configuration-panel">
    <div class="connection-heading"><div><span class="eyebrow">Research agents</span><h2>Research configuration</h2></div><span class="connection-state connection-state--unknown" data-research-configuration-badge>NOT CHECKED</span></div>
    <p class="connection-copy" data-research-configuration-summary role="status" aria-live="polite">Research configuration has not been checked yet.</p>
    <p class="connection-note" data-research-configuration-explanation>Check the server, then refresh this panel. Installed configuration does not confirm a live research run.</p>
    <div data-research-model-configuration-host></div>
    <dl class="connection-facts" data-research-configuration-facts hidden><dt>Configuration</dt><dd data-research-configuration-state></dd><dt>Model transport</dt><dd data-research-model-transport></dd><dt>Run readiness</dt><dd data-research-run-readiness></dd><dt>Qualification</dt><dd data-research-qualification-state></dd><dt>Model route</dt><dd data-research-model-route></dd><dt>Proof expiry</dt><dd data-research-qualification-expires></dd><dt>Checked</dt><dd data-research-configuration-checked></dd></dl>
    <details class="connection-details" data-research-configuration-details hidden><summary>Configuration details</summary><div class="health-details-content" data-research-configuration-detail-content></div></details>
    <div class="connection-actions"><button class="button button--quiet" type="button" data-research-configuration-refresh>Refresh configuration</button></div>
  </div>`;
  const badge = element.querySelector<HTMLElement>("[data-research-configuration-badge]");
  const summary = element.querySelector<HTMLElement>("[data-research-configuration-summary]");
  const explanation = element.querySelector<HTMLElement>("[data-research-configuration-explanation]");
  const facts = element.querySelector<HTMLElement>("[data-research-configuration-facts]");
  const state = element.querySelector<HTMLElement>("[data-research-configuration-state]");
  const transport = element.querySelector<HTMLElement>("[data-research-model-transport]");
  const runReadiness = element.querySelector<HTMLElement>("[data-research-run-readiness]");
  const qualification = element.querySelector<HTMLElement>("[data-research-qualification-state]");
  const modelRoute = element.querySelector<HTMLElement>("[data-research-model-route]");
  const qualificationExpires = element.querySelector<HTMLElement>("[data-research-qualification-expires]");
  const checked = element.querySelector<HTMLElement>("[data-research-configuration-checked]");
  const details = element.querySelector<HTMLDetailsElement>("[data-research-configuration-details]");
  const detailContent = element.querySelector<HTMLElement>("[data-research-configuration-detail-content]");
  const refreshButton = element.querySelector<HTMLButtonElement>("[data-research-configuration-refresh]");
  const modelConfigurationHost = element.querySelector<HTMLElement>("[data-research-model-configuration-host]");
  if (!badge || !summary || !explanation || !facts || !state || !transport || !runReadiness || !qualification || !modelRoute || !qualificationExpires || !checked || !details || !detailContent || !refreshButton || !modelConfigurationHost) {
    throw new Error("Research configuration panel is incomplete");
  }
  const modelConfigurationPanel = mountResearchModelConfigurationPanel(modelConfigurationHost, {
    deploymentGeneration: options.deploymentGeneration,
  });

  let disposed = false;
  let serial = 0;
  let projectId: string | undefined;
  let controller: AbortController | undefined;
  let readinessTimer: number | undefined;

  const clearDetails = (): void => {
    details.hidden = true;
    detailContent.replaceChildren();
  };
  const clearReadinessTimer = (): void => {
    if (readinessTimer !== undefined) {
      window.clearTimeout(readinessTimer);
      readinessTimer = undefined;
    }
  };
  const scheduleReadinessRefresh = (view: ResearchConfigurationView, generation: string): void => {
    clearReadinessTimer();
    if (view.qualification_state !== "current" || view.run_readiness !== "ready" ||
        view.qualification_expires_at === null) return;
    const delay = Date.parse(view.qualification_expires_at) - Date.now() - 5 * 60 * 1000;
    if (!Number.isFinite(delay) || delay <= 0) return;
    readinessTimer = window.setTimeout(() => {
      readinessTimer = undefined;
      if (disposed || options.deploymentGeneration() !== generation || !online()) return;
      refresh();
    }, Math.min(delay, 2_147_483_647));
  };
  const clearFacts = (): void => {
    facts.hidden = true;
    state.textContent = "";
    transport.textContent = "";
    runReadiness.textContent = "";
    qualification.textContent = "";
    modelRoute.textContent = "";
    qualificationExpires.textContent = "";
    checked.textContent = "";
  };
  const renderIdle = (message: string, detail: string, state: ResearchConfigurationStartState | null = null,
    badgeText = "NOT CHECKED", badgeState = "unknown"): void => {
    options.onStateChange?.(state);
    badge.className = `connection-state connection-state--${badgeState}`;
    badge.textContent = badgeText;
    summary.textContent = message;
    explanation.textContent = detail;
    clearFacts();
    clearDetails();
  };
  const renderNoProject = (): void => renderIdle(
    NO_PROJECT_RESEARCH_COPY.summary,
    NO_PROJECT_RESEARCH_COPY.explanation,
    NO_PROJECT_RESEARCH_START_STATE,
    "PROJECT REQUIRED",
    "blocked",
  );
  const renderError = (error: unknown): void => {
    options.onStateChange?.(null);
    const copy = researchConfigurationErrorCopy(error);
    badge.className = "connection-state connection-state--unknown";
    badge.textContent = "UNAVAILABLE";
    summary.textContent = copy.summary;
    explanation.textContent = copy.explanation;
    clearFacts();
    clearDetails();
    if (error instanceof ApiRequestError) {
      details.hidden = false;
      const line = document.createElement("span");
      const status = error.status >= 100 && error.status <= 599 ? String(error.status) : "no response";
      line.textContent = `Request: ${error.code} (${status})`;
      detailContent.append(line);
    }
  };
  const renderView = (view: ResearchConfigurationView): void => {
    options.onStateChange?.({
      configuration: view.configuration,
      model_transport: view.model_transport,
      qualification_state: view.qualification_state,
      run_readiness: view.run_readiness,
    });
    badge.className = `connection-state connection-state--${stateClass(view)}`;
    badge.textContent = stateLabel(view);
    state.textContent = view.configuration === "present" ? "Installed" : view.configuration === "missing" ? "Not configured" : "Needs attention";
    transport.textContent = view.model_transport === "available" ? "Available" : "Unavailable";
    runReadiness.textContent = readinessLabel(view.run_readiness);
    qualification.textContent = qualificationLabel(view.qualification_state);
    modelRoute.textContent = view.model_route ?? "Unavailable";
    qualificationExpires.textContent = expiryLabel(view.qualification_expires_at);
    checked.textContent = view.checked_at;
    facts.hidden = false;
    const copy = researchConfigurationViewCopy(view);
    summary.textContent = copy.summary;
    explanation.textContent = copy.explanation;
    clearDetails();
    if (view.missing_fields.length > 0 || view.invalid_fields.length > 0 ||
        view.readiness_reason === "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED") {
      details.hidden = false;
      const reason = document.createElement("span");
      reason.textContent = `Readiness: ${view.readiness_reason}`;
      detailContent.append(reason);
      if (view.readiness_reason === "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED") {
        const token = document.createElement("span");
        token.textContent = "Required setting: ELIOTR_MODEL_GATEWAY_READ_TOKEN";
        detailContent.append(token);
      }
      if (view.missing_fields.length > 0) {
        const missing = document.createElement("span");
        missing.textContent = `Missing settings: ${view.missing_fields.join(", ")}`;
        detailContent.append(missing);
      }
      if (view.invalid_fields.length > 0) {
        const invalid = document.createElement("span");
        invalid.textContent = `Settings needing attention: ${view.invalid_fields.join(", ")}`;
        detailContent.append(invalid);
      }
    }
    scheduleReadinessRefresh(view, view.deployment_generation);
  };
  const online = (): boolean => typeof navigator === "undefined" || navigator.onLine;
  const refreshReadiness = (): void => {
    if (disposed) return;
    clearReadinessTimer();
    serial += 1;
    controller?.abort();
    controller = undefined;
    refreshButton.disabled = false;
    if (projectId === undefined) {
      renderNoProject();
      return;
    }
    options.onStateChange?.(null);
    const generation = options.deploymentGeneration();
    if (!online()) {
      renderIdle("Offline. Research configuration is not cached.", "Reconnect, then refresh this panel.");
      return;
    }
    if (generation === undefined || generation === "" || generation === "unreachable") {
      renderIdle("Research configuration is waiting for a server check.", "Check the server before reading installed research configuration.");
      return;
    }
    const mine = serial;
    const projectAtStart = projectId;
    const local = new AbortController();
    controller = local;
    refreshButton.disabled = true;
    badge.className = "connection-state connection-state--pending";
    badge.textContent = "CHECKING";
    summary.textContent = "Checking research configuration…";
    explanation.textContent = "This reads installed configuration only; it does not test a live research run.";
    clearFacts();
    clearDetails();
    void readResearchConfiguration(generation, { signal: local.signal, projectId: projectAtStart })
      .then((view) => {
        if (mine !== serial || disposed || projectId !== projectAtStart || options.deploymentGeneration() !== generation) return;
        renderView(view);
      })
      .catch((error: unknown) => {
        if (mine !== serial || disposed || projectId !== projectAtStart || options.deploymentGeneration() !== generation) return;
        renderError(error);
      })
      .finally(() => {
        if (mine === serial) {
          controller = undefined;
          refreshButton.disabled = false;
        }
      });
  };
  const refresh = (): void => {
    modelConfigurationPanel.refresh();
    refreshReadiness();
  };
  const onProjectScopeChanged = (event: Event): void => {
    const detail = (event as CustomEvent<{ reason?: unknown; projectId?: unknown }>).detail;
    if (detail?.reason !== "project-filter") return;
    const nextProjectId = typeof detail.projectId === "string" && detail.projectId.length > 0
      ? detail.projectId : undefined;
    if (nextProjectId === projectId) return;
    projectId = nextProjectId;
    refreshReadiness();
  };
  const onModelSelectionSaved = (): void => refreshReadiness();
  const clearPrivate = (message = "Research configuration check cleared. Check the server before reading it again."): void => {
    modelConfigurationPanel.clearPrivate(message);
    clearReadinessTimer();
    serial += 1;
    controller?.abort();
    controller = undefined;
    refreshButton.disabled = false;
    renderIdle(message, "Refresh after the current owner session and deployment are available.");
  };
  const onOffline = (): void => clearPrivate("Offline. Research configuration is not cached.");
  const onOnline = (): void => {
    if (projectId === undefined) renderNoProject();
    else renderIdle("Back online. Refresh to check research configuration.", "Installed configuration does not confirm a live research run.");
  };
  const onAuthorizationCleared = (): void => clearPrivate("Sign in again before checking research configuration.");
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  window.addEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
  document.addEventListener("library:scope-changed", onProjectScopeChanged);
  modelConfigurationHost.addEventListener(RESEARCH_MODEL_SELECTION_SAVED_EVENT, onModelSelectionSaved);
  refreshButton.addEventListener("click", refresh);
  renderNoProject();
  return Object.assign(() => {
    disposed = true;
    clearPrivate();
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
    document.removeEventListener("library:scope-changed", onProjectScopeChanged);
    modelConfigurationHost.removeEventListener(RESEARCH_MODEL_SELECTION_SAVED_EVENT, onModelSelectionSaved);
    refreshButton.removeEventListener("click", refresh);
    modelConfigurationPanel();
  }, { clearPrivate, refresh });
}
