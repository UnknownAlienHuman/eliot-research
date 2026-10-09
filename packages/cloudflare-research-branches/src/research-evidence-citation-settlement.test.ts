import {
  CitationResolutionReceiptV1Schema,
  CitationResolutionReceiptV2Schema,
  type CitationResolutionOutcome,
} from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import { classifyCitationReceiptSettlement } from "./research-evidence-citation-settlement.js";

const handleRef = { id: "handle-1", revision: 1 };
const scopeRef = { id: "scope-1", revision: 1 };
const digest = "a".repeat(64);
const createdAt = "2026-10-08T12:00:00.000Z";

function v2Receipt(outcome: CitationResolutionOutcome) {
  const resolved = outcome.outcome === "RESOLVED"
    ? [{
        handle_ref: outcome.handle_ref,
        excerpt_sha256: outcome.excerpt_sha256,
        verification_receipt_ref: outcome.verification_receipt_ref,
      }]
    : [];
  const rejected = outcome.outcome === "INVALID_REFERENCE" ||
      outcome.outcome === "AUTHORITY_REVOKED" || outcome.outcome === "CONTENT_MISMATCH"
    ? [{ handle_ref: outcome.handle_ref, reason_code: outcome.outcome }]
    : [];
  return CitationResolutionReceiptV2Schema.parse({
    schema_version: 2,
    receipt_ref: { id: "citation-1", revision: 1 },
    scope_snapshot_ref: scopeRef,
    requested_handle_refs: [handleRef],
    outcomes: [outcome],
    resolved,
    rejected,
    requested_count: 1,
    resolved_count: resolved.length,
    all_material_citations_resolved: outcome.outcome === "RESOLVED",
    created_at: createdAt,
    receipt_digest: digest,
  });
}

describe("research citation settlement", () => {
  it.each([false, true])("keeps uncovered historical V1 members uncertain with a proven rejection: %s", (withRejection) => {
    const receipt = CitationResolutionReceiptV1Schema.parse({
      receipt_ref: { id: "citation-v1-incomplete", revision: 1 },
      scope_snapshot_ref: scopeRef,
      requested_handle_refs: withRejection ? [handleRef, { id: "handle-2", revision: 1 }] : [handleRef],
      resolved: [],
      rejected: withRejection ? [{ handle_ref: handleRef, reason_code: "EVIDENCE_OBJECT_INTEGRITY" }] : [],
      requested_count: withRejection ? 2 : 1,
      resolved_count: 0,
      all_material_citations_resolved: false,
      created_at: createdAt,
      receipt_digest: digest,
    });
    expect(classifyCitationReceiptSettlement(receipt)).toBe("UNCERTAIN");
  });

  it("keeps ambiguous historical V1 rejection reasons uncertain", () => {
    const receipt = CitationResolutionReceiptV1Schema.parse({
      receipt_ref: { id: "citation-v1", revision: 1 },
      scope_snapshot_ref: scopeRef,
      requested_handle_refs: [handleRef],
      resolved: [],
      rejected: [{ handle_ref: handleRef, reason_code: "EVIDENCE_SETTLEMENT_UNCERTAIN" }],
      requested_count: 1,
      resolved_count: 0,
      all_material_citations_resolved: false,
      created_at: createdAt,
      receipt_digest: digest,
    });
    expect(classifyCitationReceiptSettlement(receipt)).toBe("UNCERTAIN");
  });

  it("keeps quarantined and unknown V2 outcomes uncertain", () => {
    const quarantined: CitationResolutionOutcome = {
      handle_ref: handleRef,
      outcome: "SOURCE_QUARANTINED",
    };
    const unknown: CitationResolutionOutcome = {
      handle_ref: handleRef,
      outcome: "EFFECT_UNKNOWN",
    };
    expect(classifyCitationReceiptSettlement(v2Receipt(quarantined))).toBe("UNCERTAIN");
    expect(classifyCitationReceiptSettlement(v2Receipt(unknown))).toBe("UNCERTAIN");
  });

  it("accepts only a fully resolved V2 receipt or a proven-invalid outcome", () => {
    const resolved: CitationResolutionOutcome = {
      handle_ref: handleRef,
      outcome: "RESOLVED",
      excerpt_sha256: digest,
      verification_receipt_ref: "evidence-receipt-1:1",
    };
    const mismatch: CitationResolutionOutcome = {
      handle_ref: handleRef,
      outcome: "CONTENT_MISMATCH",
    };
    expect(classifyCitationReceiptSettlement(v2Receipt(resolved))).toBe("SETTLED");
    expect(classifyCitationReceiptSettlement(v2Receipt(mismatch))).toBe("PROVEN_INVALID");
  });
});
