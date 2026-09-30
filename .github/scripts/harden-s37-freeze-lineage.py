from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new), encoding="utf-8")


def regex_once(path: str, pattern: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE | re.DOTALL)
    if count != 1:
        raise SystemExit(f"{path}: expected one regex replacement: {pattern[:120]!r}")
    file.write_text(updated, encoding="utf-8")


replace_once(
    "packages/cloudflare-research/src/research-branch-execution.ts",
    'import { evidenceSha256 } from "@eliotr/cloudflare-evidence";',
    'import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";',
)
replace_once(
    "packages/cloudflare-research/src/research-branch-execution.ts",
    '''export interface ResearchBranchReconciliationLineage {
  readonly checkpoint: ResearchBranchReconciliationCheckpoint;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
}
''',
    '''export interface ResearchBranchReconciliationLineage {
  readonly checkpoint: ResearchBranchReconciliationCheckpoint;
  readonly read_extract_attempt_ref: string;
  readonly read_extract_request_sha256: string;
  readonly branch_analysis_attempt_ref: string;
  readonly branch_analysis_request_sha256: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
}
''',
)
regex_once(
    "packages/cloudflare-research/src/research-branch-execution.ts",
    r'''export async function readCommittedResearchBranchReconciliationLineage\(
  input: ResearchBranchReconciliationReadInput,
\): Promise<ResearchBranchReconciliationLineage \| null> \{.*?\n\}\n\nexport async function readCommittedResearchBranchReconciliation\(''',
    '''export async function readCommittedResearchBranchReconciliationLineage(
  input: ResearchBranchReconciliationReadInput,
): Promise<ResearchBranchReconciliationLineage | null> {
  const checkpoints = new WorkflowCheckpointStore(input.database);
  const committed = await checkpoints.readCommittedStageRequest(input.operation_id, "COUNTER_SEARCH");
  if (committed === null || committed.request.investigation_ref.id !== input.investigation_id) return null;
  const receipt = await checkpoints.receipt(committed.request, committed.request_sha256);
  if (receipt === null || receipt.attempt_ref !== committed.attempt_ref ||
      receipt.request_sha256 !== committed.request_sha256 ||
      receipt.investigation_ref.id !== input.investigation_id ||
      receipt.investigation_ref.revision !== committed.request.investigation_ref.revision) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  const [readLineage, analysisLineage] = await Promise.all([
    readCommittedStageLineage(checkpoints, input.operation_id, "READ_AND_EXTRACT"),
    readCommittedStageLineage(checkpoints, input.operation_id, "ANALYZE_BRANCHES"),
  ]);
  if (readLineage.request.investigation_ref.id !== input.investigation_id ||
      analysisLineage.request.investigation_ref.id !== input.investigation_id ||
      readLineage.request.investigation_ref.revision !== committed.request.investigation_ref.revision ||
      analysisLineage.request.investigation_ref.revision !== committed.request.investigation_ref.revision) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  const [read, analysis, checkpoint] = await Promise.all([
    readWorkflowObject(input.work_bucket, readLineage.receipt.output_manifest, true)
      .then(decodeResearchReadExtractCheckpoint),
    readWorkflowObject(input.work_bucket, analysisLineage.receipt.output_manifest, true)
      .then(decodeResearchBranchAnalysisCheckpoint),
    readWorkflowObject(input.work_bucket, receipt.output_manifest, true)
      .then(decodeResearchBranchReconciliationCheckpoint),
  ]);
  const analysisResults = [...analysis.branch_results]
    .sort((left, right) => left.role.localeCompare(right.role));
  const reconciledAnalysisResults = checkpoint.branch_results
    .filter((result) => result.role !== "COUNTER")
    .sort((left, right) => left.role.localeCompare(right.role));
  if (read.operation_id !== input.operation_id || analysis.operation_id !== input.operation_id ||
      checkpoint.operation_id !== input.operation_id ||
      read.investigation_ref.id !== input.investigation_id || analysis.investigation_ref.id !== input.investigation_id ||
      checkpoint.investigation_ref.id !== input.investigation_id ||
      read.investigation_ref.revision !== committed.request.investigation_ref.revision ||
      analysis.investigation_ref.revision !== committed.request.investigation_ref.revision ||
      checkpoint.investigation_ref.revision !== committed.request.investigation_ref.revision ||
      read.principal_ref !== input.principal_ref || analysis.principal_ref !== input.principal_ref ||
      checkpoint.principal_ref !== input.principal_ref ||
      !sameRef(analysis.read_extract_ref, read.checkpoint_ref) ||
      !sameRef(checkpoint.branch_analysis_ref, analysis.checkpoint_ref) ||
      canonicalEvidenceJson([...analysis.required_roles].sort()) !==
        canonicalEvidenceJson([...checkpoint.required_roles].sort()) ||
      canonicalEvidenceJson(analysisResults) !== canonicalEvidenceJson(reconciledAnalysisResults)) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  return Object.freeze({
    checkpoint,
    read_extract_attempt_ref: readLineage.attempt_ref,
    read_extract_request_sha256: readLineage.request_sha256,
    branch_analysis_attempt_ref: analysisLineage.attempt_ref,
    branch_analysis_request_sha256: analysisLineage.request_sha256,
    stage_attempt_ref: committed.attempt_ref,
    stage_request_sha256: committed.request_sha256,
  });
}

export async function readCommittedResearchBranchReconciliation(''',
)

replace_once(
    "packages/cloudflare-research/src/research-evidence-freeze-branch-lineage.ts",
    'import { evidenceSha256 } from "@eliotr/cloudflare-evidence";',
    'import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";',
)
replace_once(
    "packages/cloudflare-research/src/research-evidence-freeze-branch-lineage.ts",
    'import type { ProtocolScopeCheckpoint } from "./research-protocol-freeze.js";\n',
    'import type { ProtocolScopeCheckpoint } from "./research-protocol-freeze.js";\nimport { debtFor } from "./research-branch-execution-results.js";\n',
)
replace_once(
    "packages/cloudflare-research/src/research-evidence-freeze-branch-lineage.ts",
    '''  readonly checkpoint_ref: VersionedRef;
  readonly identity_digest: string;
  readonly stage_attempt_ref: string;
''',
    '''  readonly checkpoint_ref: VersionedRef;
  readonly identity_digest: string;
  readonly read_extract_attempt_ref: string;
  readonly read_extract_request_sha256: string;
  readonly branch_analysis_attempt_ref: string;
  readonly branch_analysis_request_sha256: string;
  readonly stage_attempt_ref: string;
''',
)
regex_once(
    "packages/cloudflare-research/src/research-evidence-freeze-branch-lineage.ts",
    r'''  const requiredRoles = \[\.\.\.checkpoint\.required_roles\]\.sort\(\);.*?  if \(input\.stage_zero\.planning_manifest_ref === undefined \|\|''',
    '''  const requiredRoles = [...checkpoint.required_roles].sort();
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
  if (input.stage_zero.planning_manifest_ref === undefined ||''',
)
replace_once(
    "packages/cloudflare-research/src/research-evidence-freeze-branch-lineage.ts",
    '''      !ID.test(lineage.stage_attempt_ref) ||
      !SHA256.test(lineage.stage_request_sha256) ||
      !sameStrings(requiredRoles, expectedRoles) ||
      new Set(requiredRoles).size !== requiredRoles.length ||
      new Set(unmetRoles).size !== unmetRoles.length ||
      new Set(contradictionRefs).size !== contradictionRefs.length ||
      new Set(debtKeys).size !== debtKeys.length ||
      debtRefs.length !== unmetRoles.length ||
      !debtCoverage) {
''',
    '''      !ID.test(lineage.read_extract_attempt_ref) ||
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
''',
)
replace_once(
    "packages/cloudflare-research/src/research-evidence-freeze-branch-lineage.ts",
    '''    checkpoint_ref: { ...checkpoint.checkpoint_ref },
    identity_digest: checkpoint.identity_digest,
    stage_attempt_ref: lineage.stage_attempt_ref,
''',
    '''    checkpoint_ref: { ...checkpoint.checkpoint_ref },
    identity_digest: checkpoint.identity_digest,
    read_extract_attempt_ref: lineage.read_extract_attempt_ref,
    read_extract_request_sha256: lineage.read_extract_request_sha256,
    branch_analysis_attempt_ref: lineage.branch_analysis_attempt_ref,
    branch_analysis_request_sha256: lineage.branch_analysis_request_sha256,
    stage_attempt_ref: lineage.stage_attempt_ref,
''',
)
