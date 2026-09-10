import { describe, expect, it } from "vitest";
import { LibraryReadinessSchema } from "./library-readiness.js";

const currentness = {
  source_revision_ref: "revision-1",
  owner_system_id: "owner-1",
  source_owner_generation: "owner-generation-1",
  source_view_ref: "view-1",
  observation_freshness: "unknown",
  observed_at: "2026-09-09T00:00:00.000Z",
  gap_refs: [],
} as const;

function value() {
  return {
    protocol: "eliotr.library-readiness.v1",
    source_id: "source-1",
    source_revision_ref: "revision-1",
    deployment_generation: "deployment-1",
    catalog_generation: "7",
    observed_at: "2026-09-09T00:00:00.000Z",
  currentness: { verification: "VERIFIED", value: currentness },
    quality_state: "standard",
    readiness_basis: "ACTIVE_VERIFIED",
    channels: [
      { source_revision_ref: "revision-1", channel: "exact_ready", state: "ready", generation: "projection-1", receipt_ref: "receipt-1", reason_codes: [], observed_at: currentness.observed_at },
      { source_revision_ref: "revision-1", channel: "lexical_ready", state: "not_requested", reason_codes: ["SEARCH_UNAVAILABLE"], observed_at: currentness.observed_at },
      { source_revision_ref: "revision-1", channel: "semantic_ready", state: "degraded", reason_codes: ["MANAGED_SEMANTIC_UNAVAILABLE"], observed_at: currentness.observed_at },
    ],
  };
}

describe("library active readiness contract", () => {
  it("accepts three independently reported channels and the full currentness witness", () => {
    expect(LibraryReadinessSchema.parse(value()).catalog_generation).toBe("7");
  });

  it("rejects a partial currentness object and unknown authority fields", () => {
    expect(LibraryReadinessSchema.safeParse({ ...value(), currentness: { verification: "NOT_VERIFIED", recorded_freshness: "unknown", reason_codes: [] } }).success).toBe(false);
    expect(LibraryReadinessSchema.safeParse({ ...value(), policy: "caller-supplied" }).success).toBe(false);
  });

  it("rejects duplicate channels, unbound channels, missing ready receipts, and invalid catalog epochs", () => {
    const complete = value();
    const duplicate = complete.channels.map((channel, index) => index === 2
      ? { ...channel, channel: "exact_ready" }
      : channel);
    expect(LibraryReadinessSchema.safeParse({ ...complete, channels: duplicate }).success).toBe(false);
    expect(LibraryReadinessSchema.safeParse({ ...complete, catalog_generation: "0" }).success).toBe(false);
    expect(LibraryReadinessSchema.safeParse({ ...complete, channels: complete.channels.map((channel, index) => index === 1
      ? { ...channel, source_revision_ref: "other-revision" }
      : channel) }).success).toBe(false);
    expect(LibraryReadinessSchema.safeParse({ ...complete, channels: complete.channels.map((channel, index) => index === 0
      ? { ...channel, generation: undefined, receipt_ref: undefined }
      : channel) }).success).toBe(false);
    expect(LibraryReadinessSchema.safeParse({ ...complete, currentness: {
      verification: "NOT_VERIFIED", recorded_freshness: "unknown", reason_codes: ["CURRENTNESS_UNAVAILABLE"],
    } }).success).toBe(true);
  });
});
