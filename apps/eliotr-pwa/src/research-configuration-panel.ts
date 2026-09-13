import { ApiRequestError } from "./api.js";
import {
  readResearchConfiguration,
  type ResearchConfigurationState,
  type ResearchConfigurationView,
  type ResearchModelTransport,
} from "./research-configuration-api.js";

export type ResearchConfigurationStartState = {
  readonly configuration: ResearchConfigurationState;
  readonly model_transport: ResearchModelTransport;
};

export interface ResearchConfigurationPanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly onStateChange?: (state: ResearchConfigurationStartState | null) => void;
}

function stateClass(view: ResearchConfigurationView): string {
  switch (view.configuration) {
    case "present": return "configured";
    case "missing": return "blocked";
    case "invalid": return "blocked";
  }
}

function stateLabel(view: ResearchConfigurationView): string {
  switch (view.configuration) {
    case "present": return "INSTALLED";
    case "missing": return "NOT CONFIGURED";
    case "invalid": return "NEEDS ATTENTION";
  }
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
    <dl class="connection-facts" data-research-configuration-facts hidden><dt>Configuration</dt><dd data-research-configuration-state></dd><dt>Model transport</dt><dd data-research-model-transport></dd><dt>Checked</dt><dd data-research-configuration-checked></dd></dl>
    <details class="connection-details" data-research-configuration-details hidden><summary>Configuration details</summary><div class="health-details-content" data-research-configuration-detail-content></div></details>
    <div class="connection-actions"><button class="button button--quiet" type="button" data-research-configuration-refresh>Refresh configuration</button></div>
  </div>`;
  const badge = element.querySelector<HTMLElement>("[data-research-configuration-badge]");
  const summary = element.querySelector<HTMLElement>("[data-research-configuration-summary]");
  const explanation = element.querySelector<HTMLElement>("[data-research-configuration-explanation]");
  const facts = element.querySelector<HTMLElement>("[data-research-configuration-facts]");
  const state = element.querySelector<HTMLElement>("[data-research-configuration-state]");
  const transport = element.querySelector<HTMLElement>("[data-research-model-transport]");
  const checked = element.querySelector<HTMLElement>("[data-research-configuration-checked]");
  const details = element.querySelector<HTMLDetailsElement>("[data-research-configuration-details]");
  const detailContent = element.querySelector<HTMLElement>("[data-research-configuration-detail-content]");
  const refreshButton = element.querySelector<HTMLButtonElement>("[data-research-configuration-refresh]");
  if (!badge || !summary || !explanation || !facts || !state || !transport || !checked || !details || !detailContent || !refreshButton) {
    throw new Error("Research configuration panel is incomplete");
  }

  let disposed = false;
  let serial = 0;
  let controller: AbortController | undefined;

  const clearDetails = (): void => {
    details.hidden = true;
    detailContent.replaceChildren();
  };
  const clearFacts = (): void => {
    facts.hidden = true;
    state.textContent = "";
    transport.textContent = "";
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
    options.onStateChange?.({ configuration: view.configuration, model_transport: view.model_transport });
    badge.className = `connection-state connection-state--${stateClass(view)}`;
    badge.textContent = stateLabel(view);
    state.textContent = view.configuration === "present" ? "Installed" : view.configuration === "missing" ? "Not configured" : "Needs attention";
    transport.textContent = view.model_transport === "available" ? "Configured" : "Unavailable";
    checked.textContent = view.checked_at;
    facts.hidden = false;
    if (view.configuration === "missing") {
      summary.textContent = "Research agents are not configured.";
      explanation.textContent = "Research cannot start until the server has a research model configuration. Add it on the server, then refresh this panel.";
    } else if (view.configuration === "invalid") {
      summary.textContent = "Research configuration needs attention.";
      explanation.textContent = "The server found settings it cannot use. Correct the listed settings, then refresh this panel.";
    } else if (view.model_transport === "available") {
      summary.textContent = "Research configuration is installed.";
      explanation.textContent = "Configuration is present; run Research to confirm execution. This panel does not test a live run.";
    } else {
      summary.textContent = "Research configuration is installed, but its model transport is unavailable.";
      explanation.textContent = "Configuration alone does not confirm a live research run. Check the server and try again later.";
    }
    clearDetails();
    if (view.missing_fields.length > 0 || view.invalid_fields.length > 0) {
      details.hidden = false;
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
  };
  const online = (): boolean => typeof navigator === "undefined" || navigator.onLine;
  const refresh = (): void => {
    if (disposed) return;
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
