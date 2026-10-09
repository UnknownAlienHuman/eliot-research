import {
  EvidenceFreezeSchema, EvidenceFreezeBranchFindingsSchema, ResearchEvidenceFreezeV3Schema,
  type EvidenceFreeze, type EvidenceFreezeBranchFindingsProvenance, type ResolvedEvidence, type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { failEvidenceFreeze as fail } from "./research-evidence-freeze-errors.js";

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

export function freezeBytes(freeze: EvidenceFreeze): Uint8Array {
  let parsed: EvidenceFreeze;
  try { parsed = EvidenceFreezeSchema.parse(freeze); }
  catch (cause) { fail("EVIDENCE_FREEZE_INPUT_INVALID", "evidence freeze failed strict validation", false, cause); }
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > 64 * 1024) fail("EVIDENCE_FREEZE_INPUT_INVALID", "evidence freeze exceeds the receipt bound");
  return bytes;
}

export async function freezeBytesV3(input: {
  readonly freeze: EvidenceFreeze;
  readonly provenance: EvidenceFreezeBranchFindingsProvenance;
  readonly resolved_evidence: readonly ResolvedEvidence[];
}): Promise<Uint8Array> {
  const handleRefs = [...new Set(input.provenance.roles.flatMap((role) =>
    role.retrieval_legs.flatMap((leg) => leg.resolved_handle_refs.map((item) => refKey(item.handle_ref)))))].sort();
  const resolvedByRef = new Map(input.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item]));
  if (resolvedByRef.size !== input.resolved_evidence.length || handleRefs.some((key) => !resolvedByRef.has(key))) {
    fail("EVIDENCE_FREEZE_EVIDENCE_INVALID", "branch query evidence is not present in the frozen citation set");
  }
  const resolvedEvidence = handleRefs.map((key) => resolvedByRef.get(key))
    .filter((item): item is ResolvedEvidence => item !== undefined)
    .sort((left, right) => refKey(left.handle.handle_ref).localeCompare(refKey(right.handle.handle_ref)));
  if (resolvedEvidence.length !== handleRefs.length) {
    fail("EVIDENCE_FREEZE_EVIDENCE_INVALID", "branch query evidence readback is incomplete");
  }
  const branchFindingsMaterial = { ...input.provenance, resolved_evidence: resolvedEvidence };
  const branchFindings = EvidenceFreezeBranchFindingsSchema.parse({
    ...branchFindingsMaterial,
    identity_digest: await evidenceSha256({ domain: "eliotr.research.evidence-freeze-branch-findings.v1", value: branchFindingsMaterial }),
  });
  const envelopeMaterial = {
    protocol: "eliotr.research.evidence-freeze.v3" as const, freeze: input.freeze, branch_findings: branchFindings,
  };
  const envelope = ResearchEvidenceFreezeV3Schema.parse({
    ...envelopeMaterial,
    identity_digest: await evidenceSha256({ domain: "eliotr.research.evidence-freeze.v3", value: envelopeMaterial }),
  });
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(envelope));
  if (bytes.byteLength > 8 * 1024 * 1024) fail("EVIDENCE_FREEZE_INPUT_INVALID", "v3 evidence freeze exceeds the workflow output bound");
  return bytes;
}
