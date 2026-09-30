import type { VersionedRef } from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { ResearchBranchReconciliationLineage } from "./research-branch-execution.js";
import type { EvidenceFreezeStageFiveLineage } from "./research-evidence-freeze-preparation.js";
import type { ProtocolScopeCheckpoint } from "./research-protocol-freeze.js";
import { debtFor } from "./research-branch-execution-results.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface EvidenceFreezeBranchLineage {
  readonly checkpoint_ref: VersionedRef;
  readonly identity_digest: string;
  readonly read_extract_attempt_ref: string;
  readonly read_extract_request_sha256: string;
  readonly branch_analysis_attempt_ref: string;
  readonly branch_analysis_request_sha256: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly required_roles: readonly string[];
  readonly unmet_required_roles: readonly string[];
  readonly unresolved_contradiction_refs: readonly string[];
  readonly open_research_debt_refs: readonly VersionedRef[];
}

export interface EvidenceFreezeLineage {
  readonly identity: Readonly<Record<string, unknown>>;
  readonly branch: EvidenceFreezeBranchLineage | null;
}

function refKey(value: VersionedRef): string {
  return `${value.id}:${value.revision}`;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function branchLineageMaterial(input: {
  readonly stage_zero: ProtocolScopeCheckpoint;
  readonly stage_five: EvidenceFreezeStageFiveLineage;
  readonly branch_reconciliation?: ResearchBranchReconciliationLineage | null;
}): Promise<EvidenceFreezeBranchLineage | null> {
  const lineage = input.branch_reconciliation;
  if (lineage === undefined || lineage === null) return null;
  const checkpoint = lineage.checkpoint;
  const { checkpoint_ref: _checkpointRef, identity_digest: _identityDigest, ...checkpointMaterial } = checkpoint;
  const digest = await evidenceSha256({
    domain: "eliotr.research.branch-reconciliation.v1",
    value: checkpointMaterial,
  });
  const requiredRoles = [...checkpoint.required_roles].sort();
  const expectedRoles = [...input.stage_zero.coverage_denominator.required_question_branches].sort();
  const resultRoles = checkpoint.branch_results.map((result) => result.role).sort();
  const unmetRoles = [...checkpoint.unmet_required_roles].sort();
  const blockedResults = checkpoint.branch_results
    .filter((result) => result.status === "BLOCKED")
    .sort((left, right) => left.role.localeCompare(right.role));
  const blockedRoles = blockedResults.map((result) => result.role);
  const contradictionRefs = [...checkpoint.unresolved_contradiction_refs].sort();
  const counter = checkpoint.branch_results.find((result) => result.role === "COUNTER");
  const expectedContradictions = counter === undefined ? [] : (await Promise.all(
    counter.evidence_handle_refs.map(async (ref) => `eliotr.research.contradiction-${await evidenceSha256({
      domain: "eliotr.research.contradiction.v1",
      handle_ref: ref,
    })}`),
  )).sort();
  const branchIdentities = await Promise.all(checkpoint.branch_results.map(async (result) => {
    const { branch_ref: _branchRef, identity_digest: _identityDigest, ...material } = result;
    const resultDigest = await evidenceSha256({ domain: "eliotr.research.branch-result.v1", value: material });
    return result.identity_digest === resultDigest &&
      result.branch_ref.id === `eliotr.research.branch-${resultDigest}` && result.branch_ref.revision === 1;
  }));
  const expectedDebts = (await Promise.all(blockedResults.map(debtFor)))
    .sort((left, right) => refKey(left.debt_ref).localeCompare(refKey(right.debt_ref)));
  const actualDebts = [...checkpoint.research_debts]
    .sort((left, right) => refKey(left.debt_ref).localeCompare(refKey(right.debt_ref)));
  const debtRefs = actualDebts.map((item) => item.debt_ref);
  const debtKeys = debtRefs.map(refKey);
  if (input.stage_zero.planning_manifest_ref === undefined ||
      input.stage_zero.planning_manifest_digest === undefined ||
      checkpoint.operation_id !== input.stage_zero.operation_id ||
      checkpoint.operation_id !== input.stage_five.operation_id ||
      checkpoint.investigation_ref.id !== input.stage_zero.investigation_ref.id ||
      checkpoint.principal_ref !== input.stage_zero.principal_ref ||
      !sameRef(checkpoint.scope_snapshot_ref, input.stage_zero.scope_snapshot_ref) ||
      !sameRef(checkpoint.inquiry_protocol_ref, input.stage_zero.profile_definition_ref) ||
      checkpoint.protocol_digest !== input.stage_zero.protocol_digest ||
      !sameRef(checkpoint.planning_manifest_ref, input.stage_zero.planning_manifest_ref) ||
      checkpoint.planning_manifest_digest !== input.stage_zero.planning_manifest_digest ||
      digest !== checkpoint.identity_digest ||
      checkpoint.checkpoint_ref.id !== `eliotr.research.branch-reconciliation-${digest}` ||
      checkpoint.checkpoint_ref.revision !== 1 ||
      !ID.test(lineage.read_extract_attempt_ref) ||
      !SHA256.test(lineage.read_extract_request_sha256) ||
      !ID.test(lineage.branch_analysis_attempt_ref) ||
      !SHA256.test(lineage.branch_analysis_request_sha256) ||
      !ID.test(lineage.stage_attempt_ref) ||
      !SHA256.test(lineage.stage_request_sha256) ||
      !sameStrings(requiredRoles, expectedRoles) ||
      !sameStrings(resultRoles, requiredRoles) ||
      !sameStrings(blockedRoles, unmetRoles) ||
      !sameStrings(contradictionRefs, expectedContradictions) ||
      branchIdentities.some((valid) => !valid) ||
      new Set(requiredRoles).size !== requiredRoles.length ||
      new Set(unmetRoles).size !== unmetRoles.length ||
      new Set(contradictionRefs).size !== contradictionRefs.length ||
      new Set(debtKeys).size !== debtKeys.length ||
      canonicalEvidenceJson(actualDebts) !== canonicalEvidenceJson(expectedDebts)) {
    throw new Error("branch reconciliation lineage is inconsistent");
  }
  return Object.freeze({
    checkpoint_ref: { ...checkpoint.checkpoint_ref },
    identity_digest: checkpoint.identity_digest,
    read_extract_attempt_ref: lineage.read_extract_attempt_ref,
    read_extract_request_sha256: lineage.read_extract_request_sha256,
    branch_analysis_attempt_ref: lineage.branch_analysis_attempt_ref,
    branch_analysis_request_sha256: lineage.branch_analysis_request_sha256,
    stage_attempt_ref: lineage.stage_attempt_ref,
    stage_request_sha256: lineage.stage_request_sha256,
    required_roles: Object.freeze(requiredRoles),
    unmet_required_roles: Object.freeze(unmetRoles),
    unresolved_contradiction_refs: Object.freeze(contradictionRefs),
    open_research_debt_refs: Object.freeze(debtRefs.map((ref) => ({ ...ref }))),
  });
}

export async function buildEvidenceFreezeLineage(input: {
  readonly operation_id: string;
  readonly stage_zero: ProtocolScopeCheckpoint;
  readonly stage_five: EvidenceFreezeStageFiveLineage;
  readonly model_profile_binding_ref: VersionedRef;
  readonly branch_reconciliation?: ResearchBranchReconciliationLineage | null;
}): Promise<EvidenceFreezeLineage> {
  const branch = await branchLineageMaterial(input);
  const identity = Object.freeze({
    operation_id: input.operation_id,
    stage_zero_attempt_ref: input.stage_zero.attempt_ref,
    stage_five_attempt_ref: input.stage_five.stage_attempt_ref,
    stage_five_request_sha256: input.stage_five.stage_request_sha256,
    scope_snapshot_ref: input.stage_zero.scope_snapshot_ref,
    protocol_digest: input.stage_zero.protocol_digest,
    denominator_digest: input.stage_zero.denominator_digest,
    model_profile_binding_ref: input.model_profile_binding_ref,
    ...(branch === null ? {} : { branch_reconciliation: branch }),
  });
  return Object.freeze({ identity, branch });
}

export async function derivedManifestRef(
  lineage: Readonly<Record<string, unknown>>,
): Promise<VersionedRef> {
  return {
    id: `eliotr.reference-manifest-${await evidenceSha256({
      domain: "eliotr.evidence-freeze.manifest-ref.v1",
      value: lineage,
    })}`,
    revision: 1,
  };
}

export async function derivedFreezeRef(
  lineage: Readonly<Record<string, unknown>>,
  manifestRef: VersionedRef,
  manifestDigest: string,
): Promise<VersionedRef> {
  return {
    id: `eliotr.evidence-freeze-${await evidenceSha256({
      domain: "eliotr.evidence-freeze.ref.v1",
      value: { ...lineage, manifest_ref: manifestRef, manifest_digest: manifestDigest },
    })}`,
    revision: 1,
  };
}
