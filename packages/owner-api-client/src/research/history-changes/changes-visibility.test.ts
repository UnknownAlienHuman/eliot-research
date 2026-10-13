import { describe, expect, it } from "vitest";
import { createChangesApi } from "./changes.js";
import type { LegacyErrorDetails, LegacyErrorFactory } from "../../legacy/http.js";
import type { SessionEpoch } from "../../transport/session/epoch.js";
import type {
  ResearchChangesScanDirection,
  ResearchChangesScanState,
} from "./changes.js";

/**
 * New decoder boundaries for the ER-45 bounded read. Every case is a pure decode: no transport, no
 * D1, no clock and no network. The intent is that a page can only report a named bounded-read state
 * that it can actually defend, and that v1 acceptance is untouched by the v2 addition.
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

/** Ascending unique sequences are what the bounded read promises, so pages build on this helper. */
const items = (count: number, first = 1) =>
  Array.from({ length: count }, (_unused, index) => item({ sequence: first + index }));

const changesFor = (data: Record<string, unknown>) => ({
  data,
  trace_id: "trace-1",
  deployment_generation: "deployment-1",
});

const v2Data = (overrides: Record<string, unknown> = {}) => {
  const { scan, ...rest } = overrides;
  return {
    protocol: "eliotr.research-changes.v2",
    items: items(1),
    next_cursor: "c2NyZW7.aG1hYy1zY2Fu",
    has_more: true,
    visibility_scan: scan ?? { direction: "FORWARD", state: "TARGET_REACHED" },
    ...rest,
  };
};

const v1Data = (overrides: Record<string, unknown> = {}) => ({
  protocol: "eliotr.research-changes.v1",
  items: items(1),
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

/** Builds a page whose scan metadata and the other result fields disagree on purpose. */
const scanOf = (direction: ResearchChangesScanDirection, state: ResearchChangesScanState) => ({ direction, state });

describe("v2 bounded-read visibility scan", () => {
  it("accepts a forward target page and exposes its scan beside the four unchanged fields", () => {
    const view = decodeOnly().decodeResearchChanges(changesFor(v2Data()), "deployment-1");
    expect(view.visibility_scan).toEqual(scanOf("FORWARD", "TARGET_REACHED"));
    expect(view).toMatchObject({
      has_more: true,
      next_cursor: "c2NyZW7.aG1hYy1zY2Fu",
      deployment_generation: "deployment-1",
    });
    expect(view.items).toHaveLength(1);
  });

  it("accepts an all-hidden budget stop with no visible items but a real continuation", () => {
    const view = decodeOnly().decodeResearchChanges(changesFor(v2Data({
      items: [],
      scan: scanOf("FORWARD", "BUDGET_STOPPED"),
    })), "deployment-1");
    expect(view.visibility_scan).toEqual(scanOf("FORWARD", "BUDGET_STOPPED"));
    expect(view.has_more).toBe(true);
    expect(view.next_cursor).not.toBeNull();
    // An empty page must not be read as a completed or exhausted read.
    expect(view.items).toEqual([]);
  });

  it("accepts an incomplete latest window and its final ordered window distinctly", () => {
    const api = decodeOnly();
    const partial = api.decodeResearchChanges(changesFor(v2Data({
      items: items(3, 4),
      scan: scanOf("LATEST", "BUDGET_STOPPED"),
    })), "deployment-1");
    expect(partial.visibility_scan).toEqual(scanOf("LATEST", "BUDGET_STOPPED"));
    expect(partial.has_more).toBe(true);
    const final = api.decodeResearchChanges(changesFor(v2Data({
      has_more: false,
      scan: scanOf("LATEST", "TARGET_REACHED"),
    })), "deployment-1");
    expect(final.visibility_scan).toEqual(scanOf("LATEST", "TARGET_REACHED"));
    expect(final.has_more).toBe(false);
    expect(final.items).toHaveLength(1);
    expect(final.next_cursor).not.toBeNull();
  });

  it("accepts exhaustion with or without visible items but never with more data promised", () => {
    const api = decodeOnly();
    const empty = api.decodeResearchChanges(changesFor(v2Data({
      items: [],
      next_cursor: "c2NyZWfuLXN0YXRl",
      has_more: false,
      scan: scanOf("FORWARD", "SOURCE_EXHAUSTED"),
    })), "deployment-1");
    expect(empty.visibility_scan).toEqual(scanOf("FORWARD", "SOURCE_EXHAUSTED"));
    expect(empty.has_more).toBe(false);
    const withItems = api.decodeResearchChanges(changesFor(v2Data({
      items: items(2, 7),
      next_cursor: "c2NyZWfuLXN0YXRl",
      has_more: false,
      scan: scanOf("LATEST", "SOURCE_EXHAUSTED"),
    })), "deployment-1");
    expect(withItems.items).toHaveLength(2);
    expect(withItems.has_more).toBe(false);
  });

  it("rejects scan metadata that contradicts the rest of the page", () => {
    const api = decodeOnly();
    const cases: ReadonlyArray<Record<string, unknown>> = [
      // BUDGET_STOPPED must continue.
      { scan: scanOf("FORWARD", "BUDGET_STOPPED"), has_more: false, next_cursor: "c2NyZW7.aG1hYy1zY2Fu" },
      { scan: scanOf("LATEST", "BUDGET_STOPPED"), has_more: true, next_cursor: null },
      // SOURCE_EXHAUSTED must not promise another read.
      { scan: scanOf("FORWARD", "SOURCE_EXHAUSTED"), has_more: true, next_cursor: "c2NyZW7.aG1hYy1zY2Fu" },
      { scan: scanOf("LATEST", "SOURCE_EXHAUSTED"), items: items(2, 5), has_more: true, next_cursor: null },
      // FORWARD target needs visible lookahead: more data, items and a cursor.
      { scan: scanOf("FORWARD", "TARGET_REACHED"), has_more: false },
      { scan: scanOf("FORWARD", "TARGET_REACHED"), items: [], next_cursor: null },
      { scan: scanOf("FORWARD", "TARGET_REACHED"), next_cursor: null },
      // A completed latest window is finite and nonempty.
      { scan: scanOf("LATEST", "TARGET_REACHED"), has_more: true },
      { scan: scanOf("LATEST", "TARGET_REACHED"), items: [], next_cursor: null },
      { scan: scanOf("LATEST", "TARGET_REACHED"), next_cursor: null },
    ];
    for (const overrides of cases) {
      expect(() => api.decodeResearchChanges(changesFor(v2Data(overrides)), "deployment-1"))
        .toThrowError();
    }
  });

  it("rejects a page that carries items without the cursor that resumes them", () => {
    const api = decodeOnly();
    for (const scan of [scanOf("FORWARD", "BUDGET_STOPPED"), scanOf("LATEST", "SOURCE_EXHAUSTED")]) {
      expect(() => api.decodeResearchChanges(changesFor(v2Data({
        items: items(2, 3),
        next_cursor: null,
        scan,
      })), "deployment-1")).toThrowError();
    }
  });

  it("rejects malformed, foreign or missing scan metadata", () => {
    const api = decodeOnly();
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { visibility_scan: undefined },
      { visibility_scan: null },
      { visibility_scan: "BUDGET_STOPPED" },
      { visibility_scan: { state: "TARGET_REACHED" } },
      { visibility_scan: { direction: "FORWARD" } },
      { visibility_scan: { direction: "forward", state: "TARGET_REACHED" } },
      { visibility_scan: { direction: "FORWARD", state: "target_reached" } },
      { visibility_scan: { direction: "FORWARD", state: "COMPLETE" } },
      { visibility_scan: { direction: "DESCENDING", state: "TARGET_REACHED" } },
      { visibility_scan: { direction: "FORWARD", state: "TARGET_REACHED", hidden_rows: 26 } },
      { visibility_scan: { direction: "FORWARD", state: "TARGET_REACHED", denied_principal: "hidden" } },
      { visibility_scan: { direction: 1, state: "TARGET_REACHED" } },
    ];
    for (const overrides of cases) {
      expect(() => api.decodeResearchChanges(changesFor(v2Data(overrides)), "deployment-1"))
        .toThrowError();
    }
  });

  it("keeps the two-part base64url cursor and its 4096-byte bound for the encrypted v2 cursor", () => {
    const api = decodeOnly();
    const bounded = `a${"a".repeat(1023)}.${"b".repeat(3071)}`;
    expect(bounded).toHaveLength(4096);
    expect(() => api.decodeResearchChanges(changesFor(v2Data({ next_cursor: bounded })), "deployment-1"))
      .not.toThrow();
    const oversize = `a${"a".repeat(1023)}.${"b".repeat(3072)}`;
    expect(oversize).toHaveLength(4097);
    for (const value of [oversize, "one-part", "a.b.c", "a b.c", "a.+"]) {
      expect(() => api.decodeResearchChanges(changesFor(v2Data({ next_cursor: value })), "deployment-1"))
        .toThrowError();
    }
  });

  it("rejects an ordering that is not ascending and unique", () => {
    const api = decodeOnly();
    const cases: ReadonlyArray<ReadonlyArray<Record<string, unknown>>> = [
      // A duplicate sequence.
      [item({ sequence: 5 }), item({ sequence: 5 })],
      // A rewind within the page.
      [item({ sequence: 9 }), item({ sequence: 4 })],
      // A repeat inside a longer ascending run.
      [item({ sequence: 2 }), item({ sequence: 3 }), item({ sequence: 3 })],
    ];
    for (const page of cases) {
      expect(() => api.decodeResearchChanges(changesFor(v2Data({ items: page })), "deployment-1"))
        .toThrowError();
    }
    // A well-ordered multi-item page still decodes.
    const view = api.decodeResearchChanges(changesFor(v2Data({ items: items(3, 11) })), "deployment-1");
    expect(view.items.map((entry) => entry.subject_ref)).toHaveLength(3);
  });

  it("preserves the server metadata scalar contract in both versions", () => {
    const api = decodeOnly();
    const long = "x".repeat(2000);
    for (const data of [v1Data, v2Data]) {
      const view = api.decodeResearchChanges(changesFor(data({ items: [item({ metadata: { note: long } })] })), "deployment-1");
      expect(view.items[0]?.metadata).toEqual({ note: long });
      for (const metadata of [{ n: Number.POSITIVE_INFINITY }, { n: Number.NaN }, { n: { deep: 1 } }, { n: [1] }]) {
        expect(() => api.decodeResearchChanges(changesFor(data({ items: [item({ metadata })] })), "deployment-1")).toThrowError();
      }
    }
  });

  it("keeps the v1 page free of the v2 scan field", () => {
    const api = decodeOnly();
    const view = api.decodeResearchChanges(changesFor(v1Data()), "deployment-1");
    expect("visibility_scan" in view).toBe(false);
    expect(() => api.decodeResearchChanges(changesFor(v1Data({
      visibility_scan: scanOf("FORWARD", "TARGET_REACHED"),
    })), "deployment-1")).toThrowError();
  });

  it("keeps v1 page acceptance unchanged where v2 is stricter", () => {
    const api = decodeOnly();
    // v1 has no ascending or continuation requirement, so these still decode.
    const empty = api.decodeResearchChanges(changesFor(v1Data({
      items: [],
      next_cursor: null,
      has_more: true,
    })), "deployment-1");
    expect(empty).toMatchObject({ has_more: true, next_cursor: null, items: [] });
    const reordered = api.decodeResearchChanges(changesFor(v1Data({
      items: [item({ sequence: 9 }), item({ sequence: 4 })],
      has_more: true,
    })), "deployment-1");
    expect(reordered.items).toHaveLength(2);
    // Unknown item fields, an unknown protocol and a bad envelope are still rejected the same way.
    for (const data of [
      v1Data({ items: [item({ hidden_rows: 2 })] }),
      { protocol: "eliotr.research-changes.v3", items: [], next_cursor: null, has_more: false },
    ]) {
      expect(() => api.decodeResearchChanges(changesFor(data), "deployment-1")).toThrowError();
    }
    expect(thrown(() => api.decodeResearchChanges(changesFor(v1Data()), "deployment-2")))
      .toMatchObject({ code: "RESEARCH_CHANGES_DEPLOYMENT_CHANGED", status: 409, retryable: true });
    expect(() => api.decodeResearchChanges(
      { data: v1Data(), trace_id: "trace-1", deployment_generation: "deployment-1", extra: 1 },
      "deployment-1",
    )).toThrowError();
  });
});

describe("v2 transport scope", () => {
  it("sends the unchanged request shape while returning the v2 view", async () => {
    const seen: { path?: string | undefined; init?: RequestInit | undefined } = {};
    const api = createChangesApi({
      requestApi: async (path, init) => {
        seen.path = path;
        seen.init = init;
        return changesFor(v2Data());
      },
    }, errors, steadyEpoch());
    const view = await api.readResearchChanges("deployment-1", { afterCursor: "c2NyZW7.aG1hYy1zY2Fu" });
    expect(view.visibility_scan).toEqual(scanOf("FORWARD", "TARGET_REACHED"));
    expect(seen.path).toBe("/api/v1/research/changes");
    const init = seen.init as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      after_cursor: "c2NyZW7.aG1hYy1zY2Fu",
      limit: 20,
      kinds: ["RESEARCH_COMPLETED", "ARTIFACT_DRAFTED", "WIKI_PUBLISHED", "SOURCE_ADMITTED", "SOURCE_UPDATED"],
    });
    expect((init.headers as Record<string, string>)["x-eliotr-csrf"]).toBe("1");
  });

  it("fences a stale v2 response the same way as v1", async () => {
    const api = createChangesApi({
      requestApi: async () => changesFor(v2Data()),
    }, errors, { capture: () => undefined, isCurrent: () => false } as unknown as SessionEpoch);
    await expect(api.readResearchChanges("deployment-1"))
      .rejects.toMatchObject({ code: "API_SESSION_CLOSED", status: 503, retryable: false });
  });
});
