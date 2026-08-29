import type { ClaimAuditItem, EvidenceFreeze, Investigation, VersionedRef } from "@eliotr/contracts";

export interface MaterialClaim {
  readonly claim_ref: VersionedRef;
  readonly text: string;
  readonly text_digest: string;
  readonly kind: ClaimAuditItem["claim_kind"];
  readonly support_handle_refs: readonly VersionedRef[];
  readonly counterevidence_handle_refs: readonly VersionedRef[];
  readonly required_precision: string;
  readonly required_source_class: string;
}

export interface ClaimAuditService {
  audit(
    investigation: Investigation,
    freeze: EvidenceFreeze,
    claims: readonly MaterialClaim[],
  ): Promise<readonly ClaimAuditItem[]>;
}

export const CLAIM_AUDIT_DIMENSIONS = [
  "reference_verification",
  "value_or_measurement_verification",
  "specification_compliance",
  "method_artifact_alignment",
  "source_satisfies_requirement",
  "supplied_excerpt_supports_requirement",
  "independence_and_fidelity",
  "evidence_grade_and_lane",
  "coverage_limitations",
  "unsupported_precision",
] as const;
