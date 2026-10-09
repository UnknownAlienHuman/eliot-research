import { describe, expect, it } from "vitest";
import { createChangesApi } from "./changes.js";
import type { LegacyErrorDetails, LegacyErrorFactory } from "../../legacy/http.js";
import type { SessionEpoch } from "../../transport/session/epoch.js";

/**
 * Targeted boundaries for the moved changes decoder. Its helpers are deliberately independent from the
 * run wire: different bounds, different patterns and its own error codes, all preserved exactly.
 */

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) => Object.assign(new Error(details.message), details);

const thrown = (run: () => unknown): LegacyErrorDetails & Error => {
  try {
    run();
  } catch (error) {
    return error as LegacyErrorDetails & Error;
  }
  throw new Error("expected the call to throw");
};

const item = (overrides: Record<string, unknown> = {}) => ({
  sequence: 1,
  change_ref: "change-1",
  kind: "SOURCE_UPDATED",
  subject_ref: "artifact-1:2",
  subject_revision: 2,
  payload_ref: "payload-1",
  payload_sha256: "a".repeat(64),
  occurred_at: "2026-10-09T12:00:00.000Z",
  metadata: { source_id: "source-1" },
  ...overrides,
});

const changesFor = (data: Record<string, unknown>) => ({
  data,
  trace_id: "trace-1",
  deployment_generation: "deployment-1",
});

const baseData = (overrides: Record<string, unknown> = {}) => ({
  protocol: "eliotr.research-changes.v1",
  items: [item()],
  next_cursor: null,
  has_more: false,
  ...overrides,
});

const steadyEpoch = (): SessionEpoch => ({
  capture: () => ({}),
  isCurrent: () => true,
  advance: () => ({}),
  close: () => undefined,
  dispose: () => undefined,
});

const decodeOnly = () => createChangesApi(
  { requestApi: async () => { throw new Error("decode-only call must not touch the transport"); } },
  errors,
  steadyEpoch(),
);

const liveEpoch = (): { readonly epoch: SessionEpoch; advance(): void } => {
  let stamp: object | undefined = {};
  const epoch: SessionEpoch = {
    capture: () => stamp,
    isCurrent: (capture: unknown) => capture === stamp,
    advance: () => { stamp = {}; return stamp; },
    close: () => { stamp = undefined; },
    dispose: () => { stamp = undefined; },
  };
  return { epoch, advance: () => { stamp = {}; } };
};

describe("changes decoder boundaries", () => {
  it("accepts a page and keys invalidation on subject ref plus revision", () => {
    expect(decodeOnly().decodeResearchChanges(changesFor(baseData()), "deployment-1"))
      .toMatchObject({
        has_more: false,
        next_cursor: null,
        deployment_generation: "deployment-1",
        items: [{ kind: "SOURCE_UPDATED", subject_ref: "artifact-1:2", subject_revision: 2 }],
      });
  });

  it("rejects a generation change, an over-cap page and an unknown kind", () => {
    const api = decodeOnly();
    expect(thrown(() => api.decodeResearchChanges(changesFor(baseData()), "deployment-2")))
      .toMatchObject({ code: "RESEARCH_CHANGES_DEPLOYMENT_CHANGED", status: 409, retryable: true });
    const oversize = changesFor(baseData({
      items: Array.from({ length: 21 }, (_unused, index) => item({ sequence: index + 1 })),
    }));
    expect(thrown(() => api.decodeResearchChanges(oversize, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_CHANGES_RESPONSE_INVALID", status: 502, retryable: false });
    const unknownKind = changesFor(baseData({ items: [item({ kind: "UNKNOWN_KIND" })] }));
    expect(thrown(() => api.decodeResearchChanges(unknownKind, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_CHANGES_RESPONSE_INVALID" });
  });

  it("rejects noncanonical metadata keys and a malformed cursor", () => {
    const api = decodeOnly();
    const unsorted = changesFor(baseData({ items: [item({ metadata: { zeta: 1, alpha: 2 } })] }));
    expect(thrown(() => api.decodeResearchChanges(unsorted, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_CHANGES_RESPONSE_INVALID" });
    const badCursor = changesFor(baseData({ next_cursor: "cursor-without-dot" }));
    expect(thrown(() => api.decodeResearchChanges(badCursor, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_CHANGES_RESPONSE_INVALID" });
    const nested = changesFor(baseData({ items: [item({ metadata: { nested: { deep: 1 } } })] }));
    expect(thrown(() => api.decodeResearchChanges(nested, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_CHANGES_RESPONSE_INVALID" });
  });

  it("rejects input-side errors before any transport call", async () => {
    let calls = 0;
    const api = createChangesApi({
      requestApi: async () => { calls += 1; return changesFor(baseData()); },
    }, errors, steadyEpoch());
    await expect(api.readResearchChanges("deployment-1", { startAt: "earliest" as "latest" }))
      .rejects.toMatchObject({ code: "RESEARCH_CHANGES_INPUT_INVALID", status: 400, retryable: false });
    await expect(api.readResearchChanges("deployment-1", { afterCursor: "no-dot-here" }))
      .rejects.toMatchObject({ code: "RESEARCH_CHANGES_INPUT_INVALID" });
    await expect(api.readResearchChanges("deployment-1", { afterCursor: null }))
      .resolves.toMatchObject({ has_more: false });
    expect(calls).toBe(1);
  });

  it("sends the exact request shape with the CSRF header", async () => {
    const seen: { path?: string | undefined; init?: RequestInit | undefined } = {};
    const api = createChangesApi({
      requestApi: async (path, init) => {
        seen.path = path;
        seen.init = init;
        return changesFor(baseData());
      },
    }, errors, steadyEpoch());
    await api.readResearchChanges("deployment-1", { startAt: "latest" });
    expect(seen.path).toBe("/api/v1/research/changes");
    const init = seen.init as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      after_cursor: null,
      limit: 20,
      kinds: ["RESEARCH_COMPLETED", "ARTIFACT_DRAFTED", "WIKI_PUBLISHED", "SOURCE_ADMITTED", "SOURCE_UPDATED"],
      start_at: "latest",
    });
    expect((init.headers as Record<string, string>)["x-eliotr-csrf"]).toBe("1");
  });
});

describe("changes transport fence across a deferred request", () => {
  it("never dispatches when the epoch is already closed or missing", async () => {
    let calls = 0;
    const api = createChangesApi({
      requestApi: async () => { calls += 1; return changesFor(baseData()); },
    }, errors, { capture: () => undefined, isCurrent: () => false } as unknown as SessionEpoch);
    await expect(api.readResearchChanges("deployment-1"))
      .rejects.toMatchObject({ code: "API_SESSION_CLOSED", status: 503, retryable: false, traceId: null });
    expect(calls).toBe(0);
  });

  it("rejects a decoded but stale feed when the epoch closed during the request", async () => {
    let release: (value: unknown) => void = () => undefined;
    const inFlight = new Promise<unknown>((resolve) => { release = resolve; });
    const { epoch, advance } = liveEpoch();
    const api = createChangesApi({ requestApi: () => inFlight }, errors, epoch);
    const pending = api.readResearchChanges("deployment-1");
    advance();
    release(changesFor(baseData()));
    await expect(pending).rejects.toMatchObject({
      code: "API_SESSION_CLOSED",
      status: 503,
      retryable: false,
      traceId: null,
    });
  });

  it("returns the decoded feed while the epoch stays current", async () => {
    const { epoch } = liveEpoch();
    const api = createChangesApi({ requestApi: async () => changesFor(baseData()) }, errors, epoch);
    await expect(api.readResearchChanges("deployment-1"))
      .resolves.toMatchObject({ deployment_generation: "deployment-1" });
  });
});
