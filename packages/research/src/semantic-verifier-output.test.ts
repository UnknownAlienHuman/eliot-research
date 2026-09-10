import type { EvidenceHandle, UnsupportedPrecisionItem } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  decodeSemanticVerifierObservation,
  SemanticVerifierOutputError,
  translateSemanticVerifierObservation,
  type SemanticVerifierObservation,
  type TrustedSemanticClaimAuditInput,
} from "./semantic-verifier-output.js";
import type { MaterialClaim } from "./claim-audit.js";

const DIGEST = "a".repeat(64);
const handle: EvidenceHandle = {
  handle_ref: { id: "evidence-1", revision: 1 },
  source_namespace_id: "namespace-1",
  source_owner_generation: "owner-generation-1",
  source_revision_ref: "revision-1",
  scope_snapshot_ref: { id: "scope-1", revision: 1 },
  anchor: { kind: "normalized_byte_range", start: 0, end: 5 },
  excerpt_sha256: DIGEST,
  excerpt_byte_length: 5,
  object_residency_key_digest: DIGEST,
  source_assurance_ceiling: "QUALIFIED",
  materializer_assurance_ceiling: "EXACT",
  terminal_state: "LIVE",
  created_at: "2026-09-10T00:00:00.000Z",
};
const claim: MaterialClaim = {
  claim_ref: { id: "claim-1", revision: 1 },
  text: "A bounded claim.",
  text_digest: DIGEST,
  kind: "observation",
  support_handle_refs: [handle.handle_ref],
  counterevidence_handle_refs: [],
  required_precision: "exact-excerpt",
  required_source_class: "official",
};
const observation: SemanticVerifierObservation = {
  schema: "eliotr.research.semantic-verifier-observation.v1",
  verifier_ref: "verifier-1",
  verifier_schema_generation: "schema-v1",
  claim_ref: claim.claim_ref,
  claim_text_digest: claim.text_digest,
  value_or_measurement_verification: "PASS",
  specification_compliance: "PASS",
  method_artifact_alignment: "NOT_APPLICABLE",
  notes: ["The supplied evidence was inspected."] ,
};

function auditInput(overrides: Partial<TrustedSemanticClaimAuditInput> = {}): TrustedSemanticClaimAuditInput {
  return {
    claim,
    exact_support_handles: [handle],
    counterevidence_handles: [],
    source_satisfies_requirement: true,
    supplied_excerpt_supports_requirement: true,
    evidence_grade: "E2",
    lane: "confirmatory",
    coverage_limitations: [],
    unsupported_precision: [],
    ...overrides,
  };
}

function decode(value: Partial<SemanticVerifierObservation> = {}): SemanticVerifierObservation {
  return decodeSemanticVerifierObservation(JSON.stringify({ ...observation, ...value }), {
    verifier_ref: "verifier-1",
    verifier_schema_generation: "schema-v1",
  });
}

describe("strict semantic verifier output", () => {
  it("translates observations with server-owned claim and evidence identity", () => {
    const result = translateSemanticVerifierObservation(decode(), auditInput());
    expect(result.claim_id).toBe(claim.claim_ref.id);
    expect(result.exact_support_handles).toEqual([handle]);
    expect(result.reference_verification).toBe("PASS");
    expect(result.disposition).toBe("SUPPORTED");
  });

  it("does not elevate reference resolution when source or excerpt support failed", () => {
    const result = translateSemanticVerifierObservation(decode(), auditInput({
      source_satisfies_requirement: false,
      supplied_excerpt_supports_requirement: false,
    }));
    expect(result.reference_verification).toBe("PASS");
    expect(result.disposition).toBe("UNSUPPORTED");
  });

  it("keeps missing or non-applicable verification unresolved", () => {
    expect(translateSemanticVerifierObservation(null, auditInput()).disposition).toBe("NOT_VERIFIABLE_IN_SCOPE");
    const unresolved = translateSemanticVerifierObservation(decode({
      value_or_measurement_verification: "NOT_APPLICABLE",
      specification_compliance: "NOT_APPLICABLE",
      method_artifact_alignment: "NOT_APPLICABLE",
    }), auditInput());
    expect(unresolved.disposition).toBe("NOT_VERIFIABLE_IN_SCOPE");
  });

  it("rejects model-owned disposition and mismatched claim or verifier bindings", () => {
    expect(() => decodeSemanticVerifierObservation(JSON.stringify({ ...observation, disposition: "SUPPORTED" }), {
      verifier_ref: "verifier-1", verifier_schema_generation: "schema-v1",
    })).toThrow(SemanticVerifierOutputError);
    expect(() => translateSemanticVerifierObservation(decode({ claim_text_digest: "b".repeat(64) }), auditInput())).toThrow(SemanticVerifierOutputError);
    expect(() => decodeSemanticVerifierObservation(JSON.stringify(observation), {
      verifier_ref: "verifier-other", verifier_schema_generation: "schema-v1",
    })).toThrow(SemanticVerifierOutputError);
  });

  it("preserves an unsupported precision debt as unresolved", () => {
    const precision: UnsupportedPrecisionItem = {
      asserted_reference_or_coordinate: "exact value",
      highest_supported_precision: "rounded value",
      source_and_coverage_basis: ["evidence-1"],
      risk_of_false_precision: "source hedge is cropped",
      required_probe_or_narrower_wording: "narrow the claim",
    };
    const result = translateSemanticVerifierObservation(decode(), auditInput({ unsupported_precision: [precision] }));
    expect(result.disposition).toBe("NOT_VERIFIABLE_IN_SCOPE");
  });
});
