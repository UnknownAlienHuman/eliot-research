import { describe, expect, it } from "vitest";
import { createRevisionApi, REVISION_PAGE_SIZE } from "./revisions.js";
import type { LegacyErrorDetails, LegacyErrorFactory } from "../../legacy/http.js";
import type { SessionEpoch } from "../../transport/session/epoch.js";

/**
 * Targeted boundaries for the moved revision decoder: epoch fencing across a real deferred transport,
 * generation 409, RECORDED_ONLY basis, channel ordering and uniqueness, and recorded-facts honesty.
 */

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) => Object.assign(new Error(details.message), details);

const channel = (channel: string, revision: string, state = "ready") => ({
  channel,
  source_revision_ref: revision,
  state,
  reason_codes: [],
  observed_at: "2026-10-09T12:00:00.000Z",
});

const revisionRow = (ref: string, admittedAt: string, channels: unknown[]) => ({
  source_revision_ref: ref,
  content_sha256: "a".repeat(64),
  captured_at: "2026-10-09T11:00:00.000Z",
  admitted_at: admittedAt,
  quality_state: "standard",
  currentness_state: "unknown",
  readiness: channels,
});

const envelopeFor = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  data: {
    protocol: "eliotr.source-revisions.v1",
    source_id: "source-1",
    head_revision_ref: "revision-2",
    observed_at: "2026-10-09T12:00:00.000Z",
    readiness_basis: "RECORDED_ONLY",
    revisions: [
      revisionRow("revision-2", "2026-10-09T11:00:00.000Z", [channel("captured", "revision-2")]),
      revisionRow("revision-1", "2026-10-09T10:00:00.000Z", [channel("captured", "revision-1")]),
    ],
    ...data,
  },
  trace_id: "trace-1",
  deployment_generation: "deployment-1",
  ...overrides,
});

const decodeOnly = () => createRevisionApi(
  { requestApi: async () => { throw new Error("decode-only call must not touch the transport"); } },
  errors,
  { capture: () => ({}), isCurrent: () => true },
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

describe("revision decoder boundaries", () => {
  it("rejects a generation change and preserves the recorded-only basis", () => {
    const api = decodeOnly();
    expect(api.decodeSourceRevisions(envelopeFor(), "source-1", "deployment-1"))
      .toMatchObject({ source_id: "source-1", head_revision_ref: "revision-2", readiness_basis: "RECORDED_ONLY" });
    expect(() => api.decodeSourceRevisions(envelopeFor(), "source-1", "deployment-2"))
      .toThrow(expect.objectContaining({ code: "CATALOG_GENERATION_CHANGED", status: 409, retryable: true }));
    const active = envelopeFor({}, { readiness_basis: "ACTIVE_ONLY" });
    expect(() => api.decodeSourceRevisions(active, "source-1", "deployment-1"))
      .toThrow(expect.objectContaining({ code: "SOURCE_REVISIONS_RESPONSE_INVALID", status: 502, retryable: false }));
  });

  it("rejects a foreign revision reference and a duplicated revision row", () => {
    const api = decodeOnly();
    const foreign = envelopeFor({}, {
      revisions: [revisionRow("revision-1", "2026-10-09T10:00:00.000Z", [channel("captured", "revision-9")])],
    });
    expect(() => api.decodeSourceRevisions(foreign, "source-1", "deployment-1")).toThrow(expect.objectContaining({
      code: "SOURCE_REVISIONS_RESPONSE_INVALID",
    }));
    const duplicated = envelopeFor({}, {
      revisions: [
        revisionRow("revision-1", "2026-10-09T10:00:00.000Z", [channel("captured", "revision-1")]),
        revisionRow("revision-1", "2026-10-09T11:00:00.000Z", [channel("captured", "revision-1")]),
      ],
    });
    expect(() => api.decodeSourceRevisions(duplicated, "source-1", "deployment-1")).toThrow(expect.objectContaining({
      code: "SOURCE_REVISIONS_RESPONSE_INVALID",
    }));
  });

  it("rejects out-of-order, duplicate and oversize channel rows", () => {
    const api = decodeOnly();
    const unordered = envelopeFor({}, {
      revisions: [revisionRow("revision-1", "2026-10-09T10:00:00.000Z", [
        channel("lexical_ready", "revision-1"), channel("captured", "revision-1"),
      ])],
    });
    expect(() => api.decodeSourceRevisions(unordered, "source-1", "deployment-1")).toThrow(expect.objectContaining({
      code: "SOURCE_REVISIONS_RESPONSE_INVALID",
    }));
    const duplicatedChannel = envelopeFor({}, {
      revisions: [revisionRow("revision-1", "2026-10-09T10:00:00.000Z", [
        channel("captured", "revision-1"), channel("captured", "revision-1"),
      ])],
    });
    expect(() => api.decodeSourceRevisions(duplicatedChannel, "source-1", "deployment-1")).toThrow(expect.objectContaining({
      code: "SOURCE_REVISIONS_RESPONSE_INVALID",
    }));
    const oversize = envelopeFor({}, {
      revisions: Array.from({ length: REVISION_PAGE_SIZE + 1 }, (_unused, index) =>
        revisionRow(`r-${index}`, "2026-10-09T10:00:00.000Z", [channel("captured", `r-${index}`)])),
    });
    expect(() => api.decodeSourceRevisions(oversize, "source-1", "deployment-1")).toThrow(expect.objectContaining({
      code: "SOURCE_REVISIONS_RESPONSE_INVALID",
    }));
  });
});

describe("revision epoch fence across a deferred transport", () => {
  it("rejects a decoded but stale page when the epoch closes after the await", async () => {
    let release: (value: unknown) => void = () => undefined;
    const inFlight = new Promise<unknown>((resolve) => { release = resolve; });
    const { epoch, advance } = liveEpoch();
    const api = createRevisionApi({ requestApi: () => inFlight }, errors, epoch);
    const pending = api.readSourceRevisionsPage("source-1", "deployment-1");
    // Resolve the injected transport first, so only a microtask separates it from the feature return.
    release(envelopeFor());
    advance();
    await expect(pending).rejects.toMatchObject({
      code: "API_SESSION_CLOSED",
      status: 503,
      retryable: false,
      traceId: null,
    });
  });

  it("returns the decoded page while the epoch stays current", async () => {
    const { epoch } = liveEpoch();
    const api = createRevisionApi({ requestApi: async () => envelopeFor() }, errors, epoch);
    await expect(api.readSourceRevisionsPage("source-1", "deployment-1"))
      .resolves.toMatchObject({ source_id: "source-1", generation: "deployment-1" });
  });
});
