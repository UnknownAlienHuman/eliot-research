import type {
  AllowedReferenceManifest,
  CitationResolutionReceipt,
  ClaimAuditItem,
  EvidenceContextBlock,
  EvidenceHandle,
  ResolvedEvidence,
  VersionedRef,
} from "@eliotr/contracts";
import { EvidenceContextBlockSchema } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import { ContextCompilationBlockedError, createEvidenceContextCompiler } from "./context-compiler.js";
import { evaluateOutputGate } from "./output-gate.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const ALPHA = "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8";
const NOW = Date.UTC(2026, 7, 31, 22, 0, 0);
const encoder = new TextEncoder();

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const handle: EvidenceHandle = {
  handle_ref: { id: "evidence-1", revision: 1 },
  source_namespace_id: "namespace-1",
  source_owner_generation: "owner-generation-1",
  source_revision_ref: "revision-1",
  scope_snapshot_ref: { id: "scope-1", revision: 1 },
  anchor: { kind: "normalized_byte_range", start: 0, end: 5 },
  excerpt_sha256: ALPHA,
  excerpt_byte_length: 5,
  coordinate_map_ref: "offset-map-1",
  object_residency_key_digest: A,
  source_assurance_ceiling: "QUALIFIED",
  materializer_assurance_ceiling: "EXACT",
  terminal_state: "LIVE",
  created_at: "2026-08-31T22:00:00.000Z",
  expires_at: "2026-09-01T22:00:00.000Z",
};
const evidence: ResolvedEvidence = {
  handle,
  exact_excerpt: "alpha",
  neighboring_text_ref: "item-1",
  source_title: "Source",
  verification_receipt_ref: "resolution-1:1",
  authorization_receipt_ref: "authorization-1",
  credential_generation: "credential-1",
  source_revision_content_sha256: A,
  scope_snapshot_digest: B,
  instruction_taint: "UNTRUSTED",
  allowed_effects: "READ_ONLY",
  resolved_at: "2026-08-31T22:00:00.000Z",
};

async function manifest(allowedHandleRefs: readonly VersionedRef[] = [handle.handle_ref]): Promise<AllowedReferenceManifest> {
  const payload = {
    manifest_ref: { id: "manifest-1", revision: 1 },
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    allowed_source_revision_refs: ["revision-1"],
    allowed_evidence_handle_refs: [...allowedHandleRefs],
    allowed_tool_definition_refs: [],
    allowed_verifier_refs: [],
    permitted_anchor_and_precision_ceilings: ["normalized_byte_range"],
    provider_and_policy_generations: { policy: "policy-1" },
    stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "private",
    allowed_use: ["research"],
    expires_at: "2026-09-01T21:00:00.000Z",
    client_fence_ref: "credential-1",
  };
  return { ...payload, manifest_digest: await sha256(canonical(payload)) };
}

async function evidenceFor(handleId: string, exactExcerpt: string): Promise<ResolvedEvidence> {
  const byteLength = encoder.encode(exactExcerpt).byteLength;
  const nextHandle: EvidenceHandle = {
    ...handle,
    handle_ref: { id: handleId, revision: 1 },
    anchor: { kind: "normalized_byte_range", start: 0, end: byteLength },
    excerpt_sha256: await sha256(exactExcerpt),
    excerpt_byte_length: byteLength,
  };
  return { ...evidence, handle: nextHandle, exact_excerpt: exactExcerpt };
}

function contextBlock(value: ResolvedEvidence): EvidenceContextBlock {
  return EvidenceContextBlockSchema.parse({
    evidence_handle_ref: value.handle.handle_ref,
    source_revision_ref: value.handle.source_revision_ref,
    instruction_taint: value.instruction_taint,
    allowed_effects: value.allowed_effects,
    quoted_content: value.exact_excerpt,
    excerpt_sha256: value.handle.excerpt_sha256,
  });
}

function claimAudit(): ClaimAuditItem {
  return {
    claim_id: "claim-1",
    claim_text_digest: ALPHA,
    claim_kind: "observation",
    exact_support_handles: [handle],
    counterevidence_handles: [],
    reference_verification: "PASS",
    value_or_measurement_verification: "NOT_APPLICABLE",
    specification_compliance: "NOT_APPLICABLE",
    method_artifact_alignment: "NOT_APPLICABLE",
    source_satisfies_requirement: true,
    supplied_excerpt_supports_requirement: true,
    independence_and_fidelity_notes: [],
    evidence_grade: "E2",
    lane: "confirmatory",
    coverage_limitations: [],
    unsupported_precision: [],
    disposition: "SUPPORTED",
  };
}

function citationReceipt(complete = true): CitationResolutionReceipt {
  return {
    receipt_ref: { id: "citation-resolution-1", revision: 1 },
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    requested_handle_refs: [handle.handle_ref],
    resolved: complete ? [{
      handle_ref: handle.handle_ref,
      excerpt_sha256: handle.excerpt_sha256,
      verification_receipt_ref: evidence.verification_receipt_ref,
    }] : [],
    rejected: complete ? [] : [{ handle_ref: handle.handle_ref, reason_code: "EVIDENCE_HANDLE_NOT_LIVE" }],
    requested_count: 1,
    resolved_count: complete ? 1 : 0,
    all_material_citations_resolved: complete,
    created_at: "2026-08-31T22:00:00.000Z",
    receipt_digest: A,
  };
}

describe("evidence context and output boundary", () => {
  it("places exact source bytes only in quoted evidence blocks", async () => {
    const compiler = createEvidenceContextCompiler({ now: () => NOW });
    const result = await compiler.compile({
      manifest: await manifest(),
      evidence: [evidence],
      modelRouteRef: "model-route-1",
      maxBytes: 4096,
    });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.quoted_content).toBe("alpha");
    expect(result.blocks[0]?.instruction_taint).toBe("UNTRUSTED");
    expect(result.source_text_in_system_fields).toBe(false);
    expect(result.system_instructions.join(" ")).not.toContain("alpha");
    expect(result.selection_receipt.admitted_candidate_refs).toEqual(["evidence-1:1"]);
  });

  it("rejects tampered excerpt bytes from model context", async () => {
    const compiler = createEvidenceContextCompiler({ now: () => NOW });
    const result = await compiler.compile({
      manifest: await manifest(),
      evidence: [{ ...evidence, exact_excerpt: "bravo" }],
      modelRouteRef: "model-route-1",
      maxBytes: 4096,
    });
    expect(result.blocks).toEqual([]);
    expect(result.selection_receipt.rejected_candidates).toEqual([{
      ref: "evidence-1:1",
      reason_code: "EVIDENCE_INTEGRITY_FAILED",
    }]);
  });

  it("uses exact block-list bytes, backfills after oversized optionals, and blocks required context failures", async () => {
    const oversized = await evidenceFor("evidence-large", `large-candidate-${"x".repeat(2048)}`);
    const smallFirst = await evidenceFor("evidence-small-1", "first small candidate");
    const smallSecond = await evidenceFor("evidence-small-2", "second small candidate");
    const expectedBlocks = [contextBlock(smallFirst), contextBlock(smallSecond)];
    const wrapperReserveUtf8Bytes = 7;
    const schemaReserveUtf8Bytes = 11;
    const exactListBytes = encoder.encode(JSON.stringify(expectedBlocks)).byteLength;
    const maxBytes = exactListBytes + wrapperReserveUtf8Bytes + schemaReserveUtf8Bytes;
    const compiler = createEvidenceContextCompiler({ now: () => NOW });
    const result = await compiler.compile({
      manifest: await manifest([
        oversized.handle.handle_ref,
        smallFirst.handle.handle_ref,
        smallSecond.handle.handle_ref,
      ]),
      evidence: [oversized, smallFirst, smallSecond],
      modelRouteRef: "model-route-1",
      maxBytes,
      wrapperReserveUtf8Bytes,
      schemaReserveUtf8Bytes,
    });

    expect(result.blocks).toEqual(expectedBlocks);
    expect(result.total_utf8_bytes).toBe(maxBytes);
    expect(result.total_utf8_bytes).toBe(
      encoder.encode(JSON.stringify(result.blocks)).byteLength + wrapperReserveUtf8Bytes + schemaReserveUtf8Bytes,
    );
    expect(result.selection_receipt.input_candidate_refs).toEqual([
      "evidence-large:1", "evidence-small-1:1", "evidence-small-2:1",
    ]);
    expect(result.selection_receipt.admitted_candidate_refs).toEqual([
      "evidence-small-1:1", "evidence-small-2:1",
    ]);
    expect(result.selection_receipt.rejected_candidates).toEqual([{
      ref: "evidence-large:1",
      reason_code: "CONTEXT_BYTE_BUDGET_EXCEEDED",
    }]);
    expect(result.system_instructions.join(" ")).not.toContain(oversized.exact_excerpt);

    const missingRef = { id: "evidence-missing", revision: 1 };
    const deniedRef = { id: "evidence-denied", revision: 1 };
    const requiredTooLarge = await evidenceFor("evidence-required-large", "required evidence that cannot fit");
    const requiredCases = [
      {
        ref: deniedRef,
        allowed: [] as readonly VersionedRef[],
        evidence: [] as readonly ResolvedEvidence[],
        maxBytes: 4096,
        reason: "REQUIRED_HANDLE_NOT_ALLOWLISTED",
      },
      {
        ref: missingRef,
        allowed: [missingRef],
        evidence: [] as readonly ResolvedEvidence[],
        maxBytes: 4096,
        reason: "REQUIRED_EVIDENCE_MISSING",
      },
      {
        ref: requiredTooLarge.handle.handle_ref,
        allowed: [requiredTooLarge.handle.handle_ref],
        evidence: [requiredTooLarge],
        maxBytes: 2,
        reason: "REQUIRED_CONTEXT_BYTE_BUDGET_EXCEEDED",
      },
    ] as const;

    for (const requiredCase of requiredCases) {
      let caught: unknown;
      try {
        await compiler.compile({
          manifest: await manifest(requiredCase.allowed),
          evidence: requiredCase.evidence,
          modelRouteRef: "model-route-1",
          maxBytes: requiredCase.maxBytes,
          requiredHandleRefs: [requiredCase.ref],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ContextCompilationBlockedError);
      expect(caught).toMatchObject({
        code: "CONTEXT_COMPILATION_BLOCKED",
        blockers: [{ handle_ref: requiredCase.ref, reason_code: requiredCase.reason }],
        selection_receipt: { operation_kind: "CONTEXT_COMPILE" },
      });
    }
  });

  it("requires the exact durable citation set instead of a caller percentage", () => {
    const base = {
      candidate_ref: { id: "artifact-1", revision: 1 },
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      claim_audit_items: [claimAudit()],
      completion_disposition: "ANSWERED_WITH_SUPPORTED_RESULT" as const,
      contains_source_derived_policy_instruction: false,
      authority_elevation_detected: false,
    };
    expect(evaluateOutputGate({ ...base, citation_resolution_receipt: citationReceipt(true) }).publishable)
      .toBe(true);
    expect(evaluateOutputGate({ ...base, citation_resolution_receipt: citationReceipt(false) }))
      .toMatchObject({ publishable: false, reason_codes: ["CITATION_RESOLUTION_NOT_100_PERCENT"] });
  });
});
