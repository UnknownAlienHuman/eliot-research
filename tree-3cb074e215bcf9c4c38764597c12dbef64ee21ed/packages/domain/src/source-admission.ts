import type { SourceAcquisitionCandidate, SourceAdmissionDecision } from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

const candidateTransitions: Readonly<Record<SourceAcquisitionCandidate["state"], readonly SourceAcquisitionCandidate["state"][]>> = {
  OBSERVED: ["RESOLVING", "REJECTED", "EXPIRED"],
  RESOLVING: ["CAPTURED", "REJECTED", "EXPIRED"],
  CAPTURED: [],
  REJECTED: [],
  EXPIRED: [],
};

export function transitionAcquisitionCandidate(
  candidate: SourceAcquisitionCandidate,
  next: SourceAcquisitionCandidate["state"],
): Result<SourceAcquisitionCandidate, DomainError> {
  const allowed = candidateTransitions[candidate.state] ?? [];
  if (!allowed.includes(next)) {
    return err(domainError("INVALID_SOURCE_CANDIDATE_TRANSITION", `${candidate.state} -> ${next}`));
  }
  return ok({ ...candidate, state: next });
}

export interface SourceAdmissionPrerequisites {
  readonly captured: boolean;
  readonly stagingReadbackVerified: boolean;
  readonly hashesVerified: boolean;
  readonly originAuthenticated: boolean;
  readonly residencyResolved: boolean;
  readonly policyAllowed: boolean;
  readonly licenseAllowed: boolean;
  readonly qualificationCompleted: boolean;
  readonly ownerGenerationCurrent: boolean;
  readonly cutoverReceiptValid: boolean | "NOT_REQUIRED";
}

export function sourceAdmissionBlockingReasons(input: SourceAdmissionPrerequisites): readonly string[] {
  const reasons: string[] = [];
  if (!input.captured) reasons.push("CANDIDATE_NOT_CAPTURED");
  if (!input.stagingReadbackVerified) reasons.push("STAGING_READBACK_NOT_VERIFIED");
  if (!input.hashesVerified) reasons.push("HASH_NOT_VERIFIED");
  if (!input.originAuthenticated) reasons.push("ORIGIN_NOT_AUTHENTICATED");
  if (!input.residencyResolved) reasons.push("RESIDENCY_NOT_RESOLVED");
  if (!input.policyAllowed) reasons.push("POLICY_DENIED");
  if (!input.licenseAllowed) reasons.push("LICENSE_DENIED");
  if (!input.qualificationCompleted) reasons.push("QUALIFICATION_INCOMPLETE");
  if (!input.ownerGenerationCurrent) reasons.push("OWNER_GENERATION_STALE");
  if (input.cutoverReceiptValid === false) reasons.push("CUTOVER_RECEIPT_INVALID");
  return reasons;
}

export function mayAdmitSource(input: SourceAdmissionPrerequisites): boolean {
  return sourceAdmissionBlockingReasons(input).length === 0;
}

export function sourceDecisionMayEnterRetrieval(decision: SourceAdmissionDecision): boolean {
  return decision.decision === "ADMITTED";
}
