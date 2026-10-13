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
  nextCursor: string,
  direction: "LATEST" | "FORWARD",
): Record<string, unknown> {
  return {
    protocol: "eliotr.research-changes.v2",
    items,
    next_cursor: nextCursor,
    has_more: false,
    visibility_scan: { direction, state: "SOURCE_EXHAUSTED" },
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: "deploy-1" }), {
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

let host: HTMLDivElement | undefined;
let dispose: ReturnType<typeof mountResearchChangesPanel> | undefined;

function mountPanel(): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  dispose = mountResearchChangesPanel(host, () => "deploy-1", () => true);
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

function timestamps(): string[] {
  return Array.from(panelHost().querySelectorAll("time"), (time) => time.dateTime);
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

describe("research changes empty FORWARD behavior in Chromium", () => {
  it("retains LATEST rows and keeps the returned cursor private until a manual check", async () => {
    const latestCursor = "opaque.latest-checkpoint";
    const forwardCursor = "opaque.forward-successor";
    const nextForwardCursor = "opaque.forward-next";
    const latestTimestamps = [
      "2026-10-13T09:00:01.000Z",
      "2026-10-13T09:00:02.000Z",
    ];
    const fetchMock = installResponses([
      jsonResponse(v2Page([changeItem(1), changeItem(2)], latestCursor, "LATEST")),
      jsonResponse(v2Page([], forwardCursor, "FORWARD")),
      jsonResponse(v2Page([], nextForwardCursor, "FORWARD")),
    ]);
    const panel = mountPanel();

    refreshButton().click();
    await waitUntil(
      () => timestamps().length === 2 && actionButton().textContent?.trim() === "Check for new work" &&
        actionButton().disabled === false,
      "two-row LATEST page and forward checkpoint",
    );
    expect(timestamps()).toEqual(latestTimestamps);
    expect(requestBody(fetchMock, 0)).toMatchObject({ after_cursor: null, start_at: "latest" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    actionButton().click();
    await waitUntil(
      () => statusText() === "No new work is available right now." && actionButton().disabled === false,
      "empty successful FORWARD response",
    );
    expect(timestamps()).toEqual(latestTimestamps);
    expect(actionButton().hidden).toBe(false);
    expect(actionButton().textContent?.trim()).toBe("Check for new work");
    expect(requestBody(fetchMock, 1)).toMatchObject({ after_cursor: latestCursor });
    expect(requestBody(fetchMock, 1)).not.toHaveProperty("start_at");
    expect(panel.innerHTML).not.toContain(latestCursor);
    expect(panel.innerHTML).not.toContain(forwardCursor);
    await nextTask();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    actionButton().click();
    await waitUntil(
      () => fetchMock.mock.calls.length === 3 && actionButton().disabled === false,
      "manual reuse of the FORWARD successor cursor",
    );
    expect(requestBody(fetchMock, 2)).toMatchObject({ after_cursor: forwardCursor });
    expect(requestBody(fetchMock, 2)).not.toHaveProperty("start_at");
    expect(statusText()).toBe("No new work is available right now.");
    expect(timestamps()).toEqual(latestTimestamps);
    expect(panel.innerHTML).not.toContain(nextForwardCursor);
    await nextTask();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
