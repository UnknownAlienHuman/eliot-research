from pathlib import Path

preparation_path = Path("packages/cloudflare-research/src/research-evidence-freeze-preparation.ts")
text = preparation_path.read_text(encoding="utf-8")
start_marker = "interface EvidenceFreezeBranchLineage {"
end_marker = "function validId(value: string, label: string): void {"
start = text.find(start_marker)
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit("branch-lineage helper block was not found after the primary patch")
text = text[:start] + text[end:]

import_anchor = 'import type { StageRequest, WorkflowPrincipal } from "@eliotr/cloudflare-workflows";\n'
lineage_import = '''import {
  buildEvidenceFreezeLineage,
  derivedFreezeRef,
  derivedManifestRef,
} from "./research-evidence-freeze-branch-lineage.js";
'''
if text.count(import_anchor) != 1:
    raise SystemExit("preparation import anchor is not unique")
text = text.replace(import_anchor, import_anchor + lineage_import)

optional_replacements = (
    (
        "    branch_reconciliation: input.branch_reconciliation,\n",
        """    ...(input.branch_reconciliation === undefined
      ? {}
      : { branch_reconciliation: input.branch_reconciliation }),
""",
    ),
    (
        "    branch_reconciliation: dependencies.branch_reconciliation,\n",
        """    ...(dependencies.branch_reconciliation === undefined
      ? {}
      : { branch_reconciliation: dependencies.branch_reconciliation }),
""",
    ),
)
for old, new in optional_replacements:
    if text.count(old) != 1:
        raise SystemExit(f"exact-optional call site was not unique: {old.strip()}")
    text = text.replace(old, new)
preparation_path.write_text(text, encoding="utf-8")

module = '''import type { VersionedRef } from "@eliotr/contracts";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { ResearchBranchReconciliationLineage } from "./research-branch-execution.js";
import type { EvidenceFreezeStageFiveLineage } from "./research-evidence-freeze-preparation.js";
import type { ProtocolScopeCheckpoint } from "./research-protocol-freeze.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface EvidenceFreezeBranchLineage {
  readonly checkpoint_ref: VersionedRef;
  readonly identity_digest: string;
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
  const unmetRoles = [...checkpoint.unmet_required_roles].sort();
  const contradictionRefs = [...checkpoint.unresolved_contradiction_refs].sort();
  const debtRefs = checkpoint.research_debts.map((item) => item.debt_ref)
    .sort((left, right) => refKey(left).localeCompare(refKey(right)));
  const debtKeys = debtRefs.map(refKey);
  const debtCoverage = unmetRoles.every((role) =>
    checkpoint.research_debts.filter((debt) => debt.blocked_refs.includes(role)).length === 1);
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
      !ID.test(lineage.stage_attempt_ref) ||
      !SHA256.test(lineage.stage_request_sha256) ||
      !sameStrings(requiredRoles, expectedRoles) ||
      new Set(requiredRoles).size !== requiredRoles.length ||
      new Set(unmetRoles).size !== unmetRoles.length ||
      new Set(contradictionRefs).size !== contradictionRefs.length ||
      new Set(debtKeys).size !== debtKeys.length ||
      debtRefs.length !== unmetRoles.length ||
      !debtCoverage) {
    throw new Error("branch reconciliation lineage is inconsistent");
  }
  return Object.freeze({
    checkpoint_ref: { ...checkpoint.checkpoint_ref },
    identity_digest: checkpoint.identity_digest,
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
'''
Path("packages/cloudflare-research/src/research-evidence-freeze-branch-lineage.ts").write_text(module, encoding="utf-8")
