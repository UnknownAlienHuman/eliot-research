import { ApiRequestError, isAuthorizationLoss } from "@eliotr/pwa-http-client";
import {
  readResearchChanges,
  type ResearchChangeFeedItem,
  type ResearchChangesScanDirection,
  type ResearchChangesView,
} from "./research-changes-api.js";

const KIND_LABELS: Record<ResearchChangeFeedItem["kind"], string> = {
  RESEARCH_COMPLETED: "Research completed",
  ARTIFACT_DRAFTED: "Research report saved",
  WIKI_PUBLISHED: "Wiki page published",
  SOURCE_ADMITTED: "Source admitted",
  SOURCE_UPDATED: "Source updated",
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

type ContinuationAction = "read-next" | "check-for-new-work";

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
    <div class="tool-heading"><div><span class="eyebrow">Activity</span><h2>Recent work</h2></div><button type="button" class="button button--quiet" data-research-changes-refresh>Refresh</button><button type="button" class="button button--quiet" data-research-changes-next hidden>Read next</button></div>
    <p class="wiki-status" data-research-changes-status role="status" aria-live="polite">Recent work has not been loaded yet.</p>
    <ol class="research-report-sections" data-research-changes-list aria-live="polite"></ol>
  </div>`;

  const refreshButton = element.querySelector<HTMLButtonElement>("[data-research-changes-refresh]");
  const nextButton = element.querySelector<HTMLButtonElement>("[data-research-changes-next]");
  const status = element.querySelector<HTMLElement>("[data-research-changes-status]");
  const list = element.querySelector<HTMLOListElement>("[data-research-changes-list]");
  if (!refreshButton || !nextButton || !status || !list) throw new Error("Research changes panel is incomplete");

  let disposed = false;
  let serial = 0;
  let controller: AbortController | undefined;
  let loadedGeneration: string | undefined;
  let loadedItems: ResearchChangeFeedItem[] = [];
  let loadedDirection: ResearchChangesScanDirection | undefined;
  let continuationCursor: string | undefined;
  let continuationAction: ContinuationAction | undefined;

  const updateButton = (): void => {
    const generation = deploymentGeneration();
    const ready = healthReady() && online() && generation !== undefined && generation !== "" &&
      generation !== "unreachable";
    const busy = controller !== undefined;
    refreshButton.disabled = busy || !ready;
    nextButton.textContent = continuationAction === "check-for-new-work" ? "Check for new work" : "Read next";
    nextButton.hidden = continuationCursor === undefined;
    nextButton.disabled = busy || !ready || continuationCursor === undefined;
    refreshButton.setAttribute("aria-busy", busy ? "true" : "false");
    nextButton.setAttribute("aria-busy", busy ? "true" : "false");
  };
  const clearScanState = (): void => {
    continuationCursor = undefined;
    continuationAction = undefined;
    loadedItems = [];
    loadedDirection = undefined;
    list.replaceChildren();
  };
  const render = (view: ResearchChangesView, continuing: boolean): void => {
    const scan = view.visibility_scan;
    const incoming = [...view.items];
    // A LATEST continuation fills the same bounded window with older slices.
    // A nonempty FORWARD page replaces the bounded window. An empty check
    // keeps the last visible window while advancing the manual continuation.
    loadedItems = continuing && scan?.direction === "LATEST"
      ? [...incoming, ...loadedItems]
      : continuing && scan?.direction === "FORWARD" && incoming.length === 0
        ? loadedItems
        : incoming;
    loadedDirection = scan?.direction;
    list.replaceChildren(...loadedItems.map(renderItem));
    continuationCursor = scan !== undefined && view.next_cursor !== null ? view.next_cursor : undefined;
    continuationAction = continuationCursor === undefined ? undefined
      : view.has_more ? "read-next" : "check-for-new-work";
    loadedGeneration = view.deployment_generation;

    if (scan?.state === "BUDGET_STOPPED") {
      status.textContent = loadedItems.length === 0
        ? "We haven't found recent work yet. There may be more to check. Select Read next to continue."
        : "Some recent work is shown. There may be more to check. Select Read next to continue.";
    } else if (scan?.direction === "LATEST" && scan.state === "TARGET_REACHED") {
      status.textContent = "Showing the latest 20 changes.";
    } else if (scan?.state === "SOURCE_EXHAUSTED") {
      status.textContent = scan.direction === "FORWARD"
        ? incoming.length === 0 ? "No new work is available right now." : "You're up to date for now."
        : loadedItems.length === 0 ? "No recent work yet." : "Showing the latest available changes.";
    } else if (scan?.direction === "FORWARD" && scan.state === "TARGET_REACHED") {
      status.textContent = "More recent work is available. Select Read next to continue.";
    } else {
      // v1 has no visibility_scan; preserve its existing presentation.
      status.textContent = view.items.length === 0
        ? "No recent work yet."
        : view.has_more ? "Showing the latest 20 changes." : "Recent work updated.";
    }
  };
  const clearPrivate = (message = "Recent work cleared. Refresh to read the current activity."): void => {
    if (disposed) return;
    serial += 1;
    controller?.abort();
    controller = undefined;
    loadedGeneration = undefined;
    clearScanState();
    status.textContent = message;
    updateButton();
  };
  const load = (mode: "latest" | "next"): void => {
    if (disposed || controller !== undefined) return;
    if (mode === "next" && continuationCursor === undefined) return;
    const generation = deploymentGeneration();
    if (!healthReady() || generation === undefined || generation === "" || generation === "unreachable") {
      clearPrivate("The owner API is not ready. Check the server before reading recent work.");
      return;
    }
    if (mode === "next" && loadedGeneration !== generation) {
      clearPrivate("The deployment changed. Refresh to read recent work again.");
      return;
    }
    if (!online()) {
      clearPrivate("Offline. Recent work is not cached.");
      return;
    }
    const afterCursor = mode === "next" ? continuationCursor : undefined;
    if (mode === "next" && afterCursor === undefined) return;
    const mine = ++serial;
    const local = new AbortController();
    controller = local;
    if (mode === "latest") {
      loadedGeneration = undefined;
      clearScanState();
      status.textContent = "Loading recent work…";
    } else {
      status.textContent = continuationAction === "check-for-new-work"
        ? "Checking for new work…"
        : "Reading next changes…";
    }
    updateButton();
    const options = afterCursor === undefined
      ? { startAt: "latest" as const, signal: local.signal }
      : { afterCursor, signal: local.signal };
    void readResearchChanges(generation, options)
      .then((view) => {
        if (disposed || mine !== serial) return;
        if (deploymentGeneration() !== generation) {
          clearPrivate("The deployment changed. Refresh to read recent work again.");
          return;
        }
        const followsLatestForwardCursor = mode === "next" &&
          continuationAction === "check-for-new-work" && loadedDirection === "LATEST" &&
          view.visibility_scan?.direction === "FORWARD";
        if (mode === "next" && (loadedDirection === undefined ||
            (view.visibility_scan?.direction !== loadedDirection && !followsLatestForwardCursor))) {
          clearPrivate("The scan changed. Refresh to read recent work again.");
          return;
        }
        render(view, mode === "next");
      })
      .catch((error: unknown) => {
        if (disposed || mine !== serial) return;
        if (error instanceof ApiRequestError && isAuthorizationLoss(error)) {
          clearPrivate("Sign in again to read recent work.");
          return;
        }
        if (error instanceof ApiRequestError &&
            (error.code === "RESEARCH_CHANGES_DEPLOYMENT_CHANGED" || error.status === 409)) {
          clearPrivate("The workspace changed. Refresh the workspace, then try again.");
          return;
        }
        if (mode === "next" && error instanceof ApiRequestError && error.retryable) {
          // Keep the exact returned continuation for an explicit retry.
          status.textContent = errorText(error);
          return;
        }
        clearPrivate(errorText(error));
      })
      .finally(() => {
        if (disposed || mine !== serial) return;
        controller = undefined;
        updateButton();
      });
  };
  const refresh = (): void => load("latest");
  const readNext = (): void => load("next");

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
  nextButton.addEventListener("click", readNext);
  window.addEventListener("offline", onOffline);
  window.addEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
  window.addEventListener("eliotr:health-lost", onHealthLost);
  window.addEventListener("eliotr:health-updated", onHealthUpdated);
  updateButton();

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    serial += 1;
    controller?.abort();
    controller = undefined;
    loadedGeneration = undefined;
    clearScanState();
    status.textContent = "Recent work cleared.";
    refreshButton.removeEventListener("click", refresh);
    nextButton.removeEventListener("click", readNext);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
    window.removeEventListener("eliotr:health-lost", onHealthLost);
    window.removeEventListener("eliotr:health-updated", onHealthUpdated);
  };
  return Object.assign(cleanup, { clearPrivate, refresh });
}
