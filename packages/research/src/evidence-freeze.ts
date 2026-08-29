import type { EvidenceFreeze, Investigation, VersionedRef } from "@eliotr/contracts";
import { domainError, err, ok, type DomainError, type Result } from "@eliotr/domain";

export interface EvidenceFreezeInput {
  readonly investigation: Investigation;
  readonly coverage_denominator_ref: VersionedRef;
  readonly included_evidence: readonly { handle_ref: VersionedRef; digest: string }[];
  readonly excluded_evidence: readonly { evidence_ref: string; reason: string }[];
  readonly provider_generations: Readonly<Record<string, string>>;
  readonly contract_protocol_digest: string;
  readonly lane_digest: string;
}

export interface EvidenceFreezeService {
  create(input: EvidenceFreezeInput): Promise<EvidenceFreeze>;
  reopen(existing: EvidenceFreeze, reason: string, newEvidenceRefs: readonly VersionedRef[]): Promise<EvidenceFreeze>;
}

export function validateEvidenceUseAgainstFreeze(
  freeze: EvidenceFreeze,
  usedHandles: readonly VersionedRef[],
): Result<void, DomainError> {
  const allowed = new Set(freeze.included_evidence.map(({ handle_ref }: EvidenceFreeze["included_evidence"][number]) => `${handle_ref.id}@${handle_ref.revision}`));
  const unexpected = usedHandles.find((ref) => !allowed.has(`${ref.id}@${ref.revision}`));
  return unexpected === undefined
    ? ok(undefined)
    : err(domainError("POST_FREEZE_EVIDENCE", `evidence ${unexpected.id}@${unexpected.revision} is not in the active freeze`));
}
