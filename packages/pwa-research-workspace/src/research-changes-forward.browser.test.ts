import { afterEach, describe, expect, it, vi } from "vitest";
import { mountResearchChangesPanel } from "./research-changes-panel.js";

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FetchMock = ReturnType<typeof installFetch>;

function installFetch(implementation: FetchImplementation) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installResponses(responses: Response[]): FetchMock {
  let nextResponse = 0;
  return installFetch(async () => {
    const response = responses[nextResponse++];
    if (response === undefined) throw new Error("Unexpected extra research changes request");
    return response;
  });
}

function changeItem(sequence: number): Record<string, unknown> {
  return {
    sequence,
    change_ref: "change:" + sequence,
    kind: "RESEARCH_COMPLETED",
    subject_ref: "research/subject-" + sequence,
    subject_revision: 1,
    payload_ref: "r2/payload-" + sequence,
    payload_sha256: "a".repeat(64),
    occurred_at: "2026-10-13T09:00:" + String(sequence).padStart(2, "0") + ".000Z",
    metadata: { stage: "SYNTHESIZE" },
  };
}

function v2Page(
  items: readonly Record<string, unknown>[],
  nextCursor: string | null,
  hasMore: boolean,
  direction: "LATEST" | "FORWARD",
  state: "BUDGET_STOPPED" | "SOURCE_EXHAUSTED" | "TARGET_REACHED",
): Record<string, unknown> {
  return {
    protocol: "eliotr.research-changes.v2",
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    visibility_scan: { direction, state },
  };
}

function jsonResponse(data: unknown, generation = "deploy-1"): Response {
  return new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generation }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(fetchMock: FetchMock, callIndex: number): Record<string, unknown> {
  const call = fetchMock.mock.calls[callIndex];
  if (call === undefined || typeof call[1]?.body !== "string") {
    throw new Error("Expected a JSON research changes request body at call " + callIndex);
  }
  return JSON.parse(call[1].body) as Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let host: HTMLDivElement | undefined;
let dispose: ReturnType<typeof mountResearchChangesPanel> | undefined;
let deploymentGeneration = "deploy-1";

function mountPanel(): HTMLDivElement {
  deploymentGeneration = "deploy-1";
  host = document.createElement("div");
  document.body.append(host);
  dispose = mountResearchChangesPanel(host, () => deploymentGeneration, () => true);
  return host;
}

function panelHost(): HTMLDivElement {
  if (host === undefined) throw new Error("Research changes panel has not been mounted");
  return host;
}

function statusText(): string {
  const status = panelHost().querySelector<HTMLElement>("[data-research-changes-status]");
  if (status === null) throw new Error("Research changes status is missing");
  return status.textContent ?? "";
}

function actionButton(): HTMLButtonElement {
  const button = panelHost().querySelector<HTMLButtonElement>("[data-research-changes-next]");
  if (button === null) throw new Error("Research changes continuation button is missing");
  return button;
}

function refreshButton(): HTMLButtonElement {
  const button = panelHost().querySelector<HTMLButtonElement>("[data-research-changes-refresh]");
  if (button === null) throw new Error("Research changes refresh button is missing");
  return button;
}

function listElement(): HTMLOListElement {
  const list = panelHost().querySelector<HTMLOListElement>("[data-research-changes-list]");
  if (list === null) throw new Error("Research changes list is missing");
  return list;
}

function timestamps(): string[] {
  return Array.from(listElement().querySelectorAll("time"), (time) => time.dateTime);
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for " + description);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  host?.remove();
  host = undefined;
  vi.unstubAllGlobals();
});

describe("research changes manual forward consumer in Chromium", () => {
  it("keeps older LATEST chunks ordered and checks forward work only after an explicit action", async () => {
    const latestCursor = "opaque.latest-resume";
    const forwardCursor = "opaque.forward-start";
    const forwardPollCursor = "opaque.forward-poll";
    const olderLatestChunk = Array.from({ length: 19 }, (_, index) => changeItem(index + 2));
    const fetchMock = installResponses([
      jsonResponse(v2Page(olderLatestChunk, latestCursor, true, "LATEST", "BUDGET_STOPPED")),
      jsonResponse(v2Page([changeItem(1)], forwardCursor, false, "LATEST", "TARGET_REACHED")),
      jsonResponse(v2Page([changeItem(21)], forwardPollCursor, false, "FORWARD", "SOURCE_EXHAUSTED")),
      jsonResponse(v2Page([changeItem(22)], "opaque.forward-more", true, "FORWARD", "TARGET_REACHED")),
    ]);
    mountPanel();

    refreshButton().click();
    await waitUntil(() => actionButton().textContent?.trim() === "Read next" && actionButton().disabled === false && listElement().children.length === 19, "partial latest continuation");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe("Some recent work is shown. There may be more to check. Select Read next to continue.");
    expect(requestBody(fetchMock, 0)).toMatchObject({ after_cursor: null, start_at: "latest" });

    actionButton().click();
    await waitUntil(
      () => listElement().children.length === 20 && actionButton().textContent?.trim() === "Check for new work",
      "completed latest window and forward checkpoint",
    );
    expect(timestamps()).toEqual(Array.from({ length: 20 }, (_, index) =>
      "2026-10-13T09:00:" + String(index + 1).padStart(2, "0") + ".000Z"));
    expect(requestBody(fetchMock, 1).after_cursor).toBe(latestCursor);
    expect(requestBody(fetchMock, 1)).not.toHaveProperty("start_at");
    await nextTask();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    actionButton().click();
    await waitUntil(
      () => timestamps()[0] === "2026-10-13T09:00:21.000Z" &&
        actionButton().textContent?.trim() === "Check for new work",
      "manual forward check",
    );
    expect(listElement().children).toHaveLength(1);
    expect(requestBody(fetchMock, 2).after_cursor).toBe(forwardCursor);
    expect(requestBody(fetchMock, 2)).not.toHaveProperty("start_at");
    await nextTask();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    actionButton().click();
    await waitUntil(
      () => timestamps()[0] === "2026-10-13T09:00:22.000Z" &&
        actionButton().textContent?.trim() === "Read next",
      "manual continuation after new work arrives",
    );
    expect(listElement().children).toHaveLength(1);
    expect(requestBody(fetchMock, 3).after_cursor).toBe(forwardPollCursor);
    expect(requestBody(fetchMock, 3)).not.toHaveProperty("start_at");
  });

  it("offers a manual check after an empty but complete LATEST window", async () => {
    const latestCursor = "opaque.empty-latest-forward";
    const fetchMock = installResponses([
      jsonResponse(v2Page([], latestCursor, false, "LATEST", "SOURCE_EXHAUSTED")),
      jsonResponse(v2Page([changeItem(1)], "opaque.empty-forward-poll", false, "FORWARD", "SOURCE_EXHAUSTED")),
    ]);
    mountPanel();

    refreshButton().click();
    await waitUntil(() => actionButton().textContent?.trim() === "Check for new work", "empty latest checkpoint");
    expect(statusText()).toBe("No recent work yet.");
    expect(listElement().children).toHaveLength(0);
    await nextTask();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    actionButton().click();
    await waitUntil(() => timestamps()[0] === "2026-10-13T09:00:01.000Z", "work after empty latest scan");
    expect(actionButton().textContent?.trim()).toBe("Check for new work");
    expect(requestBody(fetchMock, 1).after_cursor).toBe(latestCursor);
    expect(requestBody(fetchMock, 1)).not.toHaveProperty("start_at");
  });

  it("uses plain language for an empty incomplete result without claiming there is no work", async () => {
    const fetchMock = installResponses([
      jsonResponse(v2Page([], "opaque.empty-budget", true, "LATEST", "BUDGET_STOPPED")),
    ]);
    mountPanel();

    refreshButton().click();
    await waitUntil(() => actionButton().textContent?.trim() === "Read next" && actionButton().disabled === false && statusText() !== "Loading recent work…", "empty incomplete result");
    expect(statusText()).toBe("We haven't found recent work yet. There may be more to check. Select Read next to continue.");
    expect(statusText()).not.toMatch(/bounded|search limit|no recent work yet/i);
    await nextTask();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a failed forward check with the exact same cursor only after another click", async () => {
    let callCount = 0;
    const cursor = "opaque.forward-retry";
    const fetchMock = installFetch(async () => {
      const current = callCount++;
      if (current === 0) {
        return jsonResponse(v2Page([changeItem(1)], cursor, false, "LATEST", "SOURCE_EXHAUSTED"));
      }
      if (current === 1) throw new TypeError("Failed to fetch");
      if (current === 2) {
        return jsonResponse(v2Page([], cursor, false, "FORWARD", "SOURCE_EXHAUSTED"));
      }
      throw new Error("Unexpected extra research changes request");
    });
    mountPanel();

    refreshButton().click();
    await waitUntil(() => actionButton().textContent?.trim() === "Check for new work", "forward retry cursor");
    actionButton().click();
    await waitUntil(
      () => statusText().includes("temporarily unavailable") && actionButton().disabled === false,
      "retryable forward check error",
    );
    expect(actionButton().textContent?.trim()).toBe("Check for new work");
    expect(listElement().children).toHaveLength(1);
    expect(requestBody(fetchMock, 1).after_cursor).toBe(cursor);
    await nextTask();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    actionButton().click();
    await waitUntil(() => statusText() === "No new work is available right now.", "forward check retry result");
    expect(actionButton().textContent?.trim()).toBe("Check for new work");
    expect(requestBody(fetchMock, 2).after_cursor).toBe(cursor);
    expect(requestBody(fetchMock, 2)).not.toHaveProperty("start_at");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not restore forward results after authorization is cleared", async () => {
    const pending = deferred<Response>();
    let callCount = 0;
    const fetchMock = installFetch(async () => {
      if (callCount++ === 0) {
        return jsonResponse(v2Page([changeItem(1)], "opaque.auth-forward", false, "LATEST", "SOURCE_EXHAUSTED"));
      }
      return pending.promise;
    });
    mountPanel();

    refreshButton().click();
    await waitUntil(() => actionButton().textContent?.trim() === "Check for new work", "latest forward cursor");
    actionButton().click();
    await waitUntil(() => fetchMock.mock.calls.length === 2, "pending forward request");
    const signal = fetchMock.mock.calls[1]?.[1]?.signal;
    if (signal === undefined || signal === null) throw new Error("Forward request did not receive an abort signal");

    window.dispatchEvent(new Event("eliotr:authorization-cleared"));
    expect(signal.aborted).toBe(true);
    expect(listElement().children).toHaveLength(0);
    expect(actionButton().hidden).toBe(true);
    expect(statusText()).toBe("Sign in again to read recent work.");

    pending.resolve(jsonResponse(v2Page([changeItem(2)], "opaque.auth-next", false, "FORWARD", "SOURCE_EXHAUSTED")));
    await nextTask();
    expect(listElement().children).toHaveLength(0);
    expect(actionButton().hidden).toBe(true);
    expect(statusText()).toBe("Sign in again to read recent work.");
  });

  it("does not restore forward results after disposal", async () => {
    const pending = deferred<Response>();
    let callCount = 0;
    const fetchMock = installFetch(async () => {
      if (callCount++ === 0) {
        return jsonResponse(v2Page([changeItem(1)], "opaque.dispose-forward", false, "LATEST", "SOURCE_EXHAUSTED"));
      }
      return pending.promise;
    });
    mountPanel();

    refreshButton().click();
    await waitUntil(() => actionButton().textContent?.trim() === "Check for new work", "latest forward cursor");
    actionButton().click();
    await waitUntil(() => fetchMock.mock.calls.length === 2, "pending forward request");
    const signal = fetchMock.mock.calls[1]?.[1]?.signal;
    if (signal === undefined || signal === null) throw new Error("Forward request did not receive an abort signal");

    dispose?.();
    expect(signal.aborted).toBe(true);
    expect(listElement().children).toHaveLength(0);
    expect(statusText()).toBe("Recent work cleared.");

    pending.resolve(jsonResponse(v2Page([changeItem(2)], "opaque.dispose-next", false, "FORWARD", "SOURCE_EXHAUSTED")));
    await nextTask();
    expect(listElement().children).toHaveLength(0);
    expect(statusText()).toBe("Recent work cleared.");
    actionButton().click();
    await nextTask();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
