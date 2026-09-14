import { ApiRequestError } from "./api.js";
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

function errorCopy(error: unknown): { readonly summary: string; readonly explanation: string } {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 || error.status === 403) {
      return {
        summary: "Sign in again to check research configuration.",
        explanation: "The current owner session cannot read this configuration.",
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
  }
  return {
    summary: "Research configuration could not be read.",
    explanation: "Refresh this panel after checking the server connection.",
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
  if (!badge || !summary || !explanation || !facts || !state || !transport || !runReadiness || !qualification || !modelRoute || !qualificationExpires || !checked || !details || !detailContent || !refreshButton) {
    throw new Error("Research configuration panel is incomplete");
  }

  let disposed = false;
  let serial = 0;
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
  const renderIdle = (message: string, detail: string): void => {
    options.onStateChange?.(null);
    badge.className = "connection-state connection-state--unknown";
    badge.textContent = "NOT CHECKED";
    summary.textContent = message;
    explanation.textContent = detail;
    clearFacts();
    clearDetails();
  };
  const renderError = (error: unknown): void => {
    options.onStateChange?.(null);
    const copy = errorCopy(error);
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
    if (view.configuration === "missing") {
      summary.textContent = "Research agents are not configured.";
      explanation.textContent = "Research cannot start until the server has a research model configuration. Add it on the server, then refresh this panel.";
    } else if (view.configuration === "invalid") {
      summary.textContent = "Research configuration needs attention.";
      explanation.textContent = "The server found settings it cannot use. Correct the listed settings, then refresh this panel.";
    } else if (view.model_transport === "available" && view.run_readiness === "ready") {
      summary.textContent = "Research is ready to start with current qualification proofs.";
      explanation.textContent = "The server read the installed model route and current proofs. This panel does not contact the model provider.";
    } else if (view.run_readiness === "lazy_renewal") {
      summary.textContent = "Research can start; access will renew when the run starts.";
      explanation.textContent = "Qualification is due for renewal. The server will renew it lazily at run time; this panel does not verify a live provider connection.";
    } else if (view.readiness_reason === "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED") {
      summary.textContent = "Research cannot start until renewal access is installed.";
      explanation.textContent = "The current qualification proofs need renewal, but the server Read token is missing. An administrator must install it, then refresh this panel.";
    } else if (view.qualification_state === "unavailable") {
      summary.textContent = "Research readiness could not be established.";
      explanation.textContent = "The server could not read current qualification proofs. Refresh after the server configuration and database are available.";
    } else if (view.model_transport === "available") {
      summary.textContent = "Research is not ready to start.";
      explanation.textContent = "The server reported a readiness blocker. Refresh this panel after the owner configuration is corrected.";
    } else {
      summary.textContent = "Research configuration is installed, but its model transport is unavailable.";
      explanation.textContent = "Configuration alone does not confirm a live research run. Check the server and try again later.";
    }
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
  const refresh = (): void => {
    if (disposed) return;
    clearReadinessTimer();
    serial += 1;
    controller?.abort();
    controller = undefined;
    refreshButton.disabled = false;
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
    const local = new AbortController();
    controller = local;
    refreshButton.disabled = true;
    badge.className = "connection-state connection-state--pending";
    badge.textContent = "CHECKING";
    summary.textContent = "Checking research configuration…";
    explanation.textContent = "This reads installed configuration only; it does not test a live research run.";
    clearFacts();
    clearDetails();
    void readResearchConfiguration(generation, local.signal)
      .then((view) => {
        if (mine !== serial || disposed || options.deploymentGeneration() !== generation) return;
        renderView(view);
      })
      .catch((error: unknown) => {
        if (mine !== serial || disposed) return;
        renderError(error);
      })
      .finally(() => {
        if (mine === serial) {
          controller = undefined;
          refreshButton.disabled = false;
        }
      });
  };
  const clearPrivate = (message = "Research configuration check cleared. Check the server before reading it again."): void => {
    clearReadinessTimer();
    serial += 1;
    controller?.abort();
    controller = undefined;
    refreshButton.disabled = false;
    renderIdle(message, "Refresh after the current owner session and deployment are available.");
  };
  const onOffline = (): void => clearPrivate("Offline. Research configuration is not cached.");
  const onOnline = (): void => renderIdle("Back online. Refresh to check research configuration.", "Installed configuration does not confirm a live research run.");
  const onAuthorizationCleared = (): void => clearPrivate("Sign in again before checking research configuration.");
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  window.addEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
  refreshButton.addEventListener("click", refresh);
  return Object.assign(() => {
    disposed = true;
    clearPrivate();
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
    refreshButton.removeEventListener("click", refresh);
  }, { clearPrivate, refresh });
}
