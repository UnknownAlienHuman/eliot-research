import type { ClaimAuditItem, CompletionDisposition, VersionedRef } from "@eliotr/contracts";

export interface PublicationCandidate {
  readonly candidate_ref: VersionedRef;
  readonly claim_audit_items: readonly ClaimAuditItem[];
  readonly completion_disposition: CompletionDisposition;
  readonly exact_citation_resolution_rate: number;
  readonly contains_source_derived_policy_instruction: boolean;
  readonly authority_elevation_detected: boolean;
}

export interface OutputGateDecision {
  readonly publishable: boolean;
  readonly reason_codes: readonly string[];
}

export function evaluateOutputGate(candidate: PublicationCandidate): OutputGateDecision {
  const reasons: string[] = [];
  if (candidate.exact_citation_resolution_rate !== 1) reasons.push("CITATION_RESOLUTION_NOT_100_PERCENT");
  if (candidate.contains_source_derived_policy_instruction) reasons.push("SOURCE_DERIVED_POLICY_INSTRUCTION");
  if (candidate.authority_elevation_detected) reasons.push("UNSUPPORTED_AUTHORITY_ELEVATION");
  if (candidate.claim_audit_items.some((item) => item.disposition === "UNSUPPORTED" || item.disposition === "CONTRADICTED")) {
    reasons.push("MATERIAL_CLAIM_FAILED_AUDIT");
  }
  return { publishable: reasons.length === 0, reason_codes: reasons };
}
