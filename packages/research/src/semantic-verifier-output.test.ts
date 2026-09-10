import type { EvidenceHandle, UnsupportedPrecisionItem } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  decodeSemanticVerifierBatch,
  SemanticVerifierOutputError,
  translateSemanticVerifierBatch,
  type SemanticVerifierBatch,
  type SemanticVerifierObservation,
  type TrustedSemanticClaimAuditInput,
} from "./semantic-verifier-output.js";
import type { MaterialClaim } from "./claim-audit.js";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
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
const counterHandle: EvidenceHandle = { ...handle, handle_ref: { id: "evidence-counter", revision: 1 }, excerpt_sha256: OTHER_DIGEST };
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
const secondClaim: MaterialClaim = {
  ...claim,
  claim_ref: { id: "claim-2", revision: 1 },
  text: "A second bounded claim.",
};
const contradictoryClaim: MaterialClaim = {
  ...claim,
  claim_ref: { id: "claim-3", revision: 1 },
  counterevidence_handle_refs: [counterHandle.handle_ref],
};
const verifier = {
  verifier_ref: "verifier-1",
  verifier_schema_generation: "schema-v1",
  evidence_input_sha256: DIGEST,
};

function observationFor(inputClaim: MaterialClaim, overrides: Partial<SemanticVerifierObservation> = {}): SemanticVerifierObservation {
  return {
    claim_ref: inputClaim.claim_ref,
    claim_text_digest: inputClaim.text_digest,
    value_or_measurement_verification: "PASS",
    specification_compliance: "PASS",
    method_artifact_alignment: "PASS",
    source_satisfies_requirement: "PASS",
    supplied_excerpt_supports_requirement: "PASS",
    contradiction_observed: false,
    unsupported_precision_observed: false,
    notes: ["The supplied evidence was inspected."],
    ...overrides,
  };
}

function batchFor(claims: readonly MaterialClaim[] = [claim], overrides: Partial<SemanticVerifierObservation> = {}): SemanticVerifierBatch {
  return {
    schema: "eliotr.research.semantic-verifier-observation.v1",
    ...verifier,
    claims: claims.map((inputClaim) => observationFor(inputClaim, overrides)),
  };
}

function auditInput(inputClaim: MaterialClaim = claim, overrides: Partial<TrustedSemanticClaimAuditInput> = {}): TrustedSemanticClaimAuditInput {
  return {
    claim: inputClaim,
    exact_support_handles: [handle],
    counterevidence_handles: inputClaim.counterevidence_handle_refs.length > 0 ? [counterHandle] : [],
    reference_resolution_verified: true,
    semantic_verifier_qualified: true,
    required_dimensions: [
      "value_or_measurement_verification",
      "specification_compliance",
      "method_artifact_alignment",
    ],
    source_requirement_applicable: true,
    excerpt_requirement_applicable: true,
    evidence_grade: "E2",
    lane: "confirmatory",
    coverage_limitations: [],
    unsupported_precision: [],
    ...overrides,
  };
}

function decodeBatch(claims: readonly MaterialClaim[] = [claim], overrides: Partial<SemanticVerifierObservation> = {}): SemanticVerifierBatch {
  return decodeSemanticVerifierBatch(JSON.stringify(batchFor(claims, overrides)), { ...verifier, claims });
}

function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("expected one translated claim");
  return item;
}

describe("strict semantic verifier batch", () => {
  it("decodes one batch and translates every claim with trusted identity", () => {
    const claims = [claim, secondClaim];
    const result = translateSemanticVerifierBatch(decodeBatch(claims), claims.map((inputClaim) => auditInput(inputClaim)));
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.claim_id)).toEqual(["claim-1", "claim-2"]);
    expect(result.every((item) => item.reference_verification === "PASS")).toBe(true);
    expect(result.every((item) => item.disposition === "SUPPORTED")).toBe(true);
  });

  it("keeps source and excerpt semantics separate from reference resolution", () => {
    const result = only(translateSemanticVerifierBatch(
      decodeBatch([claim], {
        source_satisfies_requirement: "FAIL",
        supplied_excerpt_supports_requirement: "FAIL",
      }),
      [auditInput()],
    ));
    expect(result.reference_verification).toBe("PASS");
    expect(result.source_satisfies_requirement).toBe(false);
    expect(result.supplied_excerpt_supports_requirement).toBe(false);
    expect(result.disposition).toBe("UNSUPPORTED");
  });

  it("does not let missing qualification or required NOT_APPLICABLE waive verification", () => {
    expect(only(translateSemanticVerifierBatch(null, [auditInput()])).disposition).toBe("NOT_VERIFIABLE_IN_SCOPE");
    expect(only(translateSemanticVerifierBatch(
      decodeBatch(),
      [auditInput(claim, { semantic_verifier_qualified: false })],
    )).disposition).toBe("NOT_VERIFIABLE_IN_SCOPE");
    expect(only(translateSemanticVerifierBatch(
      decodeBatch([claim], { value_or_measurement_verification: "NOT_APPLICABLE" }),
      [auditInput()],
    )).disposition).toBe("NOT_VERIFIABLE_IN_SCOPE");
    const noSemanticRequirement = only(translateSemanticVerifierBatch(
      decodeBatch(),
      [auditInput(claim, { required_dimensions: [], source_requirement_applicable: false, excerpt_requirement_applicable: false })],
    ));
    expect(noSemanticRequirement.disposition).toBe("NOT_VERIFIABLE_IN_SCOPE");
  });

  it("rejects extra model disposition and incomplete or mismatched claim batches", () => {
    const invalid = { ...batchFor(), claims: [{ ...observationFor(claim), disposition: "SUPPORTED" }] };
    expect(() => decodeSemanticVerifierBatch(JSON.stringify(invalid), { ...verifier, claims: [claim] })).toThrow(SemanticVerifierOutputError);
    expect(() => decodeSemanticVerifierBatch(JSON.stringify(batchFor([claim, secondClaim])), { ...verifier, claims: [claim] })).toThrow(SemanticVerifierOutputError);
    expect(() => decodeSemanticVerifierBatch(JSON.stringify(batchFor([claim], { claim_text_digest: OTHER_DIGEST })), { ...verifier, claims: [claim] })).toThrow(SemanticVerifierOutputError);
    expect(() => decodeSemanticVerifierBatch(JSON.stringify({ ...batchFor([claim, secondClaim]), claims: [observationFor(claim), observationFor(claim)] }), { ...verifier, claims: [claim, secondClaim] })).toThrow(SemanticVerifierOutputError);
    expect(() => decodeSemanticVerifierBatch(JSON.stringify({ ...batchFor(), evidence_input_sha256: OTHER_DIGEST }), { ...verifier, evidence_input_sha256: OTHER_DIGEST, claims: [claim] })).not.toThrow();
    expect(() => decodeSemanticVerifierBatch(JSON.stringify({ ...batchFor(), evidence_input_sha256: OTHER_DIGEST }), { ...verifier, claims: [claim] })).toThrow(SemanticVerifierOutputError);
  });

  it("keeps contradiction and precision observations bounded by trusted evidence", () => {
    const contradiction = only(translateSemanticVerifierBatch(
      decodeBatch([contradictoryClaim], { contradiction_observed: true }),
      [auditInput(contradictoryClaim)],
    ));
    expect(contradiction.disposition).toBe("CONTRADICTED");

    const precision: UnsupportedPrecisionItem = {
      asserted_reference_or_coordinate: "exact value",
      highest_supported_precision: "rounded value",
      source_and_coverage_basis: ["evidence-1"],
      risk_of_false_precision: "source hedge is cropped",
      required_probe_or_narrower_wording: "narrow the claim",
    };
    const unresolved = only(translateSemanticVerifierBatch(
      decodeBatch(),
      [auditInput(claim, { unsupported_precision: [precision] })],
    ));
    expect(unresolved.disposition).toBe("NOT_VERIFIABLE_IN_SCOPE");
    expect(unresolved.unsupported_precision).toEqual([precision]);
  });
});
