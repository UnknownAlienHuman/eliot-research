import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import {
  readResearchChanges,
  type ResearchChangeFeedItem,
  type ResearchChangesView,
} from "./research-changes-api.js";

const KIND_LABELS: Record<ResearchChangeFeedItem["kind"], string> = {
  RESEARCH_COMPLETED: "Research completed",
  ARTIFACT_DRAFTED: "Research report saved",
  WIKI_PUBLISHED: "Wiki page published",
};

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (isAuthorizationLoss(error)) return "Sign in again to read recent work.";
    if (error.code === "RESEARCH_CHANGES_DEPLOYMENT_CHANGED" || error.status === 409) {
      return "The workspace changed. Refresh the workspace, then try again.";
    }
    if (error.code === "API_UNREACHABLE" || error.code === "API_REQUEST_ABORTED" || error.retryable) {
      return "Recent work is temporarily unavailable. Check the server connection and try again.";
    }
  }
  return "Recent work could not be read. Try again when the owner API is ready.";
}

function renderItem(item: ResearchChangeFeedItem): HTMLElement {
  const row = document.createElement("li");
  row.className = "research-report-section";
  const heading = document.createElement("h3");
  heading.textContent = KIND_LABELS[item.kind];
  const time = document.createElement("time");
  time.dateTime = item.occurred_at;
  time.textContent = dateLabel(item.occurred_at);
  time.className = "wiki-proposal-meta";
  row.append(heading, time);
  return row;
}

export function mountResearchChangesPanel(
  element: HTMLElement,
  deploymentGeneration: () => string | undefined,
  healthReady: () => boolean = () => false,
): (() => void) & { clearPrivate(message?: string): void; refresh(): void } {
  element.innerHTML = `<div class="research-changes-panel">
    <div class="tool-heading"><div><span class="eyebrow">Activity</span><h2>Recent work</h2></div><button type="button" class="button button--quiet" data-research-changes-refresh>Refresh</button></div>
    <p class="wiki-status" data-research-changes-status role="status" aria-live="polite">Recent work has not been loaded yet.</p>
    <ol class="research-report-sections" data-research-changes-list aria-live="polite"></ol>
  </div>`;

  const refreshButton = element.querySelector<HTMLButtonElement>("[data-research-changes-refresh]");
  const status = element.querySelector<HTMLElement>("[data-research-changes-status]");
  const list = element.querySelector<HTMLOListElement>("[data-research-changes-list]");
  if (!refreshButton || !status || !list) throw new Error("Research changes panel is incomplete");

  let disposed = false;
  let serial = 0;
  let controller: AbortController | undefined;
  let loadedGeneration: string | undefined;

  const updateButton = (): void => {
    const generation = deploymentGeneration();
    refreshButton.disabled = controller !== undefined || !healthReady() || !online() ||
      generation === undefined || generation === "" || generation === "unreachable";
    refreshButton.setAttribute("aria-busy", controller === undefined ? "false" : "true");
  };
  const clearList = (): void => list.replaceChildren();
  const render = (view: ResearchChangesView): void => {
    clearList();
    view.items.forEach((item) => list.append(renderItem(item)));
    status.textContent = view.items.length === 0
      ? "No recent work yet."
      : view.has_more ? "Showing the latest 20 changes." : "Recent work updated.";
    loadedGeneration = view.deployment_generation;
  };
  const clearPrivate = (message = "Recent work cleared. Refresh to read the current activity."): void => {
    serial += 1;
    controller?.abort();
    controller = undefined;
    loadedGeneration = undefined;
    clearList();
    status.textContent = message;
    updateButton();
  };
  const refresh = (): void => {
    if (disposed || controller !== undefined) return;
    const generation = deploymentGeneration();
    if (!healthReady() || generation === undefined || generation === "" || generation === "unreachable") {
      clearList();
      status.textContent = "The owner API is not ready. Check the server before reading recent work.";
      updateButton();
      return;
    }
    if (!online()) {
      clearPrivate("Offline. Recent work is not cached.");
      return;
    }
    const mine = ++serial;
    const local = new AbortController();
    controller = local;
    clearList();
    status.textContent = "Loading recent work…";
    updateButton();
    void readResearchChanges(generation, { startAt: "latest", signal: local.signal })
      .then((view) => {
        if (disposed || mine !== serial || deploymentGeneration() !== generation) return;
        render(view);
      })
      .catch((error: unknown) => {
        if (disposed || mine !== serial) return;
        clearList();
        status.textContent = errorText(error);
      })
      .finally(() => {
        if (disposed || mine !== serial) return;
        controller = undefined;
        updateButton();
      });
  };

  const onOffline = (): void => clearPrivate("Offline. Recent work is not cached.");
  const onAuthorizationCleared = (): void => clearPrivate("Sign in again to read recent work.");
  const onHealthLost = (): void => clearPrivate("The server connection changed. Refresh to read recent work again.");
  const onHealthUpdated = (): void => {
    if (loadedGeneration !== undefined && deploymentGeneration() !== loadedGeneration) {
      clearPrivate("The deployment changed. Refresh to read recent work again.");
      return;
    }
    updateButton();
  };

  refreshButton.addEventListener("click", refresh);
  window.addEventListener("offline", onOffline);
  window.addEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
  window.addEventListener("eliotr:health-lost", onHealthLost);
  window.addEventListener("eliotr:health-updated", onHealthUpdated);
  updateButton();

  const cleanup = (): void => {
    disposed = true;
    serial += 1;
    controller?.abort();
    controller = undefined;
    refreshButton.removeEventListener("click", refresh);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
    window.removeEventListener("eliotr:health-lost", onHealthLost);
    window.removeEventListener("eliotr:health-updated", onHealthUpdated);
  };
  return Object.assign(cleanup, { clearPrivate, refresh });
}
