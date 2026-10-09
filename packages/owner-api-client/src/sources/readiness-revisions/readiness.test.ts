import { describe, expect, it } from "vitest";
import { createReadinessApi } from "./readiness.js";
import type { LegacyErrorDetails, LegacyErrorFactory } from "../../legacy/http.js";
import type { SessionEpoch } from "../../transport/session/epoch.js";

/**
 * Targeted boundaries for the moved readiness decoder: owner-supplied epoch fencing across a real
 * deferred transport resolution, the deployment/head 409 distinction, and the recorded-facts contract.
 * Assertions name behavior, not implementation shapes.
 */

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) => Object.assign(new Error(details.message), details);

const envelopeFor = (overrides: Record<string, unknown> = {}) => ({
  data: {
    protocol: "eliotr.library-readiness.v1",
    source_id: "source-1",
    source_revision_ref: "revision-1",
    deployment_generation: "deployment-1",
    catalog_generation: "7",
    observed_at: "2026-10-09T12:00:00.000Z",
    currentness: { verification: "NOT_VERIFIED", recorded_freshness: "unknown", reason_codes: ["NOT_CHECKED"] },
    quality_state: "standard",
    readiness_basis: "ACTIVE_VERIFIED",
    channels: ["exact_ready", "lexical_ready", "semantic_ready"].map(channel => ({
      channel, source_revision_ref: "revision-1", state: "not_requested", reason_codes: [], observed_at: "2026-10-09T12:00:00.000Z",
    })),
    ...overrides,
  },
  trace_id: "trace-1",
  deployment_generation: "deployment-1",
});

const decodeOnly = () => createReadinessApi(
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
  return {
    epoch,
    advance: () => { stamp = {}; },
  };
};

describe("readiness decoder boundaries", () => {
  it("separates a deployment change from a source-head change and preserves recorded facts", () => {
    const api = decodeOnly();
    const current = api.decodeLibraryReadiness(envelopeFor(), "source-1", "deployment-1");
    expect(current).toMatchObject({ source_id: "source-1", source_revision_ref: "revision-1" });
    expect(() => api.decodeLibraryReadiness(envelopeFor(), "source-1", "deployment-1", "revision-2"))
      .toThrow(expect.objectContaining({ code: "LIBRARY_SOURCE_HEAD_CHANGED", status: 409, retryable: true }));
    expect(() => api.decodeLibraryReadiness(envelopeFor(), "source-1", "deployment-2"))
      .toThrow(expect.objectContaining({ code: "LIBRARY_DEPLOYMENT_CHANGED", status: 409, retryable: true }));
  });

  it("rejects a foreign source and an unknown envelope key instead of inferring identity", () => {
    const api = decodeOnly();
    expect(() => api.decodeLibraryReadiness(envelopeFor(), "source-2", "deployment-1"))
      .toThrow(expect.objectContaining({ code: "LIBRARY_READINESS_RESPONSE_INVALID", status: 502, retryable: false }));
    const noisy = envelopeFor({ unexpected_field: 1 });
    expect(() => api.decodeLibraryReadiness(noisy, "source-1", "deployment-1"))
      .toThrow(expect.objectContaining({ code: "LIBRARY_READINESS_RESPONSE_INVALID", status: 502 }));
  });
});

describe("readiness epoch fence across a deferred transport", () => {
  it("rejects a decoded but stale response when the epoch closes after the await", async () => {
    let release: (value: unknown) => void = () => undefined;
    const inFlight = new Promise<unknown>((resolve) => { release = resolve; });
    const { epoch, advance } = liveEpoch();
    const api = createReadinessApi({ requestApi: () => inFlight }, errors, epoch);
    const pending = api.readLibraryReadiness("source-1", "deployment-1");
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

  it("returns the decoded view while the epoch stays current", async () => {
    const { epoch } = liveEpoch();
    const api = createReadinessApi({ requestApi: async () => envelopeFor() }, errors, epoch);
    await expect(api.readLibraryReadiness("source-1", "deployment-1"))
      .resolves.toMatchObject({ source_id: "source-1", source_revision_ref: "revision-1" });
  });
});
