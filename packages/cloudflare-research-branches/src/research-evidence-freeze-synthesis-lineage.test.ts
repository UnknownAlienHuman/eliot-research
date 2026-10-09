import { describe, expect, it } from "vitest";
import { ResolvedEvidenceSchema, type ResolvedEvidence } from "@eliotr/contracts";
import { assertFrozenBranchEvidenceBinding } from "./research-evidence-freeze-synthesis-lineage.js";

function resolvedEvidence(): ResolvedEvidence {
  return ResolvedEvidenceSchema.parse({
    handle: {
      handle_ref: { id: "handle-1", revision: 1 },
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-1",
      source_revision_ref: "source-revision-1",
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      anchor: { kind: "normalized_byte_range", start: 0, end: 4 },
      excerpt_sha256: "a".repeat(64),
      excerpt_byte_length: 4,
      object_residency_key_digest: "b".repeat(64),
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: "2026-10-09T00:00:00.000Z",
    },
    exact_excerpt: "fact",
    verification_receipt_ref: "verification-1",
    authorization_receipt_ref: "authorization-1",
    credential_generation: "credential-1",
    source_revision_content_sha256: "c".repeat(64),
    scope_snapshot_digest: "d".repeat(64),
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: "2026-10-09T00:00:00.000Z",
  });
}

describe("frozen branch evidence binding", () => {
  it("accepts fresh resolution receipts without modifying committed evidence", () => {
    const committed = resolvedEvidence();
    const bytes = JSON.stringify(committed);
    const fresh = { ...committed, verification_receipt_ref: "verification-2",
      authorization_receipt_ref: "authorization-2", resolved_at: "2026-10-09T01:00:00.000Z",
      source_title: "Updated display title" };
    expect(() => assertFrozenBranchEvidenceBinding([committed, fresh], [fresh])).not.toThrow();
    expect(JSON.stringify(committed)).toBe(bytes);
  });

  it("rejects another source, span or owner behind the same handle and excerpt", () => {
    const committed = resolvedEvidence();
    const substitutions: readonly ResolvedEvidence[] = [
      { ...committed, handle: { ...committed.handle, source_revision_ref: "other-revision" } },
      { ...committed, handle: { ...committed.handle, source_namespace_id: "other-namespace" } },
      { ...committed, handle: { ...committed.handle, source_owner_generation: "other-owner" } },
      { ...committed, handle: { ...committed.handle, anchor: { kind: "normalized_byte_range", start: 4, end: 8 } } },
      { ...committed, handle: { ...committed.handle, object_residency_key_digest: "e".repeat(64) } },
      { ...committed, source_revision_content_sha256: "e".repeat(64) },
      { ...committed, scope_snapshot_digest: "e".repeat(64) },
      { ...committed, credential_generation: "other-credential" },
    ];
    for (const frozen of substitutions) {
      expect(() => assertFrozenBranchEvidenceBinding([committed], [frozen])).toThrow();
    }
  });

  it("rejects missing, duplicate, foreign and contradictory committed handles", () => {
    const committed = resolvedEvidence();
    const foreign = { ...committed, handle: { ...committed.handle,
      handle_ref: { id: "foreign-handle", revision: 1 } } };
    expect(() => assertFrozenBranchEvidenceBinding([committed], [])).toThrow();
    expect(() => assertFrozenBranchEvidenceBinding([committed], [committed, committed])).toThrow();
    expect(() => assertFrozenBranchEvidenceBinding([committed], [foreign])).toThrow();
    expect(() => assertFrozenBranchEvidenceBinding([committed, { ...committed,
      handle: { ...committed.handle, source_revision_ref: "other-revision" } }], [committed])).toThrow();
    expect(() => assertFrozenBranchEvidenceBinding([], [])).not.toThrow();
  });
});
