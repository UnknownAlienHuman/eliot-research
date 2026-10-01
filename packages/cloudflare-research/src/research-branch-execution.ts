import {
  ResearchBranchAnalysisCheckpointSchema,
  ResearchBranchReconciliationCheckpointSchema,
  ResearchBranchRoleSchema,
  ResearchReadExtractCheckpointSchema,
  type ResearchBranchAnalysisCheckpoint,
  type ResearchBranchEvidenceItem,
  type ResearchBranchReconciliationCheckpoint,
  type ResearchBranchResult,
  type ResearchBranchRole,
  type ResearchDebt,
  type ResearchPlanningManifest,
  type ResearchReadExtractCheckpoint,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import {
  WorkflowCheckpointStore,
  fail,
  readCommittedStageLineage,
  readWorkflowObject,
  type StageRequest,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-workflows";
import {
  canonicalBytes,
  decodeResearchBranchAnalysisCheckpoint,
  decodeResearchBranchReconciliationCheckpoint,
  decodeResearchReadExtractCheckpoint,
  sameRef,
  uniqueSorted,
  withIdentity,
} from "./research-branch-execution-shared.js";
import {
  branchEvidence,
  loadContext,
  type BranchExecutionContext,
  type ResearchBranchExecutionDependencies,
} from "./research-branch-execution-context.js";
import {
  buildRoleResult,
  buildRoleResultFromModelOutput,
  debtFor,
  evidenceForRole,
} from "./research-branch-execution-results.js";
import { parseBranchRoleModelOutput } from "./research-branch-role-output.js";
import type { ResearchBranchRoleModelExecutor } from "./research-branch-role-model.js";

export type {
  ResearchBranchAnalysisCheckpoint,
  ResearchBranchReconciliationCheckpoint,
  ResearchBranchResult,
  ResearchBranchRole,
  ResearchReadExtractCheckpoint,
} from "@eliotr/contracts";
export type { ResearchBranchExecutionDependencies } from "./research-branch-execution-context.js";
export {
  decodeResearchBranchAnalysisCheckpoint,
  decodeResearchBranchReconciliationCheckpoint,
  decodeResearchReadExtractCheckpoint,
} from "./research-branch-execution-shared.js";

export interface ResearchBranchExecutionHandlers {
  readonly read_and_extract: WorkflowStageHandler;
  readonly analyze_branches: WorkflowStageHandler;
  readonly counter_search: WorkflowStageHandler;
  readonly recover: (stage: StageRequest["stage"], request: StageRequest, principal: WorkflowPrincipal) => Promise<Uint8Array | null>;
}

async function readExtractCheckpoint(
  context: BranchExecutionContext,
  request: StageRequest,
  principal: WorkflowPrincipal,
): Promise<ResearchReadExtractCheckpoint> {
  const value = {
    protocol: "eliotr.research.read-extract.v1" as const,
    operation_id: request.operation_id,
    investigation_ref: { ...request.investigation_ref },
    principal_ref: principal.principal_ref,
    scope_snapshot_ref: { ...context.protocol.scope_snapshot_ref },
    inquiry_protocol_ref: { ...context.protocol.profile_definition_ref },
    protocol_digest: context.protocol.protocol_digest,
    planning_manifest_ref: { ...context.planning.manifest_ref },
    planning_manifest_digest: context.planning.identity_digest,
    retrieval_request_digest: context.stage_five.retrieval_request_digest,
    evidence: branchEvidence(context),
    omitted_candidate_refs: uniqueSorted(context.stage_five.evidence_pack.omitted_candidates.map((item) => item.candidate_id)),
    created_at: context.protocol.observed_at,
  };
  return ResearchReadExtractCheckpointSchema.parse(await withIdentity(
    "eliotr.research.read-extract.v1",
    "eliotr.research.read-extract-",
    value,
  ));
}

interface RoleInvocation {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly attempt_ref: string;
  readonly budget_receipt_ref: string;
  readonly input_bytes: Uint8Array;
  readonly role_model?: ResearchBranchRoleModelExecutor | undefined;
}

/**
 * Executes one required role. Roles with no pre-selected evidence never cost a
 * model call: they resolve deterministically to BLOCKED (or CANDIDATE_READY for
 * an evidence-optional SOURCE_AUDIT). Any other role requires the substantive
 * role model executor; without it the checkpoint fails closed.
 */
async function executeRole(
  planning: ResearchPlanningManifest,
  invocation: RoleInvocation,
  role: ResearchBranchRole,
  evidence: readonly ResearchBranchEvidenceItem[],
): Promise<ResearchBranchResult> {
  const selected = evidenceForRole(role, evidence);
  if (selected.length === 0) {
    return buildRoleResult(planning, role, evidence);
  }
  const roleModel = invocation.role_model;
  if (roleModel === undefined) fail("WORKFLOW_CONFIGURATION_MISSING");
  const outputBytes = await roleModel.executeRole({
    role,
    request: invocation.request,
    principal: invocation.principal,
    attempt_ref: invocation.attempt_ref,
    budget_receipt_ref: invocation.budget_receipt_ref,
    input_bytes: invocation.input_bytes,
  });
  const output = parseBranchRoleModelOutput(outputBytes, role, selected.map((item) => item.handle_ref));
  return buildRoleResultFromModelOutput(planning, role, selected, output);
}

async function analyzeCheckpoint(
  dependencies: ResearchBranchExecutionDependencies,
  context: BranchExecutionContext,
  invocation: RoleInvocation,
  read: ResearchReadExtractCheckpoint,
): Promise<ResearchBranchAnalysisCheckpoint> {
  const requiredRoles = uniqueSorted(context.planning.required_branch_roles.map((role) => ResearchBranchRoleSchema.parse(role)));
  const analysisRoles = requiredRoles.filter((role) => role !== "COUNTER");
  const results: ResearchBranchResult[] = [];
  const roleInvocation: RoleInvocation = { ...invocation, role_model: dependencies.role_model };
  for (const role of analysisRoles) results.push(await executeRole(context.planning, roleInvocation, role, read.evidence));
  const value = {
    protocol: "eliotr.research.branch-analysis.v1" as const,
    operation_id: read.operation_id,
    investigation_ref: { ...read.investigation_ref },
    principal_ref: read.principal_ref,
    scope_snapshot_ref: { ...read.scope_snapshot_ref },
    inquiry_protocol_ref: { ...read.inquiry_protocol_ref },
    protocol_digest: read.protocol_digest,
    planning_manifest_ref: { ...read.planning_manifest_ref },
    planning_manifest_digest: read.planning_manifest_digest,
    read_extract_ref: { ...read.checkpoint_ref },
    required_roles: requiredRoles,
    branch_results: results,
    created_at: read.created_at,
  };
  return ResearchBranchAnalysisCheckpointSchema.parse(await withIdentity(
    "eliotr.research.branch-analysis.v1",
    "eliotr.research.branch-analysis-",
    value,
  ));
}

async function reconciliationCheckpoint(
  dependencies: ResearchBranchExecutionDependencies,
  context: BranchExecutionContext,
  invocation: RoleInvocation,
  analysis: ResearchBranchAnalysisCheckpoint,
  read: ResearchReadExtractCheckpoint,
): Promise<ResearchBranchReconciliationCheckpoint> {
  const results = [...analysis.branch_results];
  const counterRequired = analysis.required_roles.includes("COUNTER");
  if (counterRequired) {
    results.push(await executeRole(
      context.planning,
      { ...invocation, role_model: dependencies.role_model },
      "COUNTER",
      read.evidence,
    ));
  }
  results.sort((left, right) => left.role.localeCompare(right.role));
  const unmet = results.filter((item) => item.status === "BLOCKED").map((item) => item.role).sort();
  const debts: ResearchDebt[] = [];
  for (const result of results) if (result.status === "BLOCKED") debts.push(await debtFor(result));
  const counter = results.find((item) => item.role === "COUNTER");
  const contradictions = counter === undefined ? [] : await Promise.all(counter.evidence_handle_refs.map(async (ref) =>
    `eliotr.research.contradiction-${await evidenceSha256({
      domain: "eliotr.research.contradiction.v1",
      handle_ref: ref,
    })}`));
  const value = {
    protocol: "eliotr.research.branch-reconciliation.v1" as const,
    operation_id: analysis.operation_id,
    investigation_ref: { ...analysis.investigation_ref },
    principal_ref: analysis.principal_ref,
    scope_snapshot_ref: { ...analysis.scope_snapshot_ref },
    inquiry_protocol_ref: { ...analysis.inquiry_protocol_ref },
    protocol_digest: analysis.protocol_digest,
    planning_manifest_ref: { ...analysis.planning_manifest_ref },
    planning_manifest_digest: analysis.planning_manifest_digest,
    branch_analysis_ref: { ...analysis.checkpoint_ref },
    required_roles: [...analysis.required_roles],
    branch_results: results,
    unmet_required_roles: unmet,
    unresolved_contradiction_refs: uniqueSorted(contradictions),
    research_debts: debts,
    counter_search_status: !counterRequired ? "NOT_REQUIRED" as const
      : counter?.status === "CANDIDATE_READY" ? "COMPLETE" as const
        : "PARTIAL" as const,
    created_at: analysis.created_at,
  };
  return ResearchBranchReconciliationCheckpointSchema.parse(await withIdentity(
    "eliotr.research.branch-reconciliation.v1",
    "eliotr.research.branch-reconciliation-",
    value,
  ));
}
export function createResearchBranchExecutionHandlers(
  dependencies: ResearchBranchExecutionDependencies,
): ResearchBranchExecutionHandlers {
  const read_and_extract: WorkflowStageHandler = async ({ request, principal }) => {
    if (request.stage !== "READ_AND_EXTRACT") fail("WORKFLOW_INPUT_INVALID");
    const context = await loadContext(dependencies, request, principal);
    return canonicalBytes(await readExtractCheckpoint(context, request, principal));
  };
  const analyze_branches: WorkflowStageHandler = async ({ request, principal, input_bytes, attempt_ref, budget_receipt_ref }) => {
    if (request.stage !== "ANALYZE_BRANCHES") fail("WORKFLOW_INPUT_INVALID");
    const context = await loadContext(dependencies, request, principal);
    const read = decodeResearchReadExtractCheckpoint(input_bytes);
    if (read.operation_id !== request.operation_id || read.investigation_ref.id !== request.investigation_ref.id ||
        read.principal_ref !== principal.principal_ref || !sameRef(read.scope_snapshot_ref, context.protocol.scope_snapshot_ref) ||
        !sameRef(read.planning_manifest_ref, context.planning.manifest_ref) || read.planning_manifest_digest !== context.planning.identity_digest) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    return canonicalBytes(await analyzeCheckpoint(dependencies, context,
      { request, principal, attempt_ref, budget_receipt_ref, input_bytes }, read));
  };
  const counter_search: WorkflowStageHandler = async ({ request, principal, input_bytes, attempt_ref, budget_receipt_ref }) => {
    if (request.stage !== "COUNTER_SEARCH") fail("WORKFLOW_INPUT_INVALID");
    const context = await loadContext(dependencies, request, principal);
    const analysis = decodeResearchBranchAnalysisCheckpoint(input_bytes);
    if (analysis.operation_id !== request.operation_id || analysis.investigation_ref.id !== request.investigation_ref.id ||
        analysis.principal_ref !== principal.principal_ref || !sameRef(analysis.scope_snapshot_ref, context.protocol.scope_snapshot_ref) ||
        !sameRef(analysis.planning_manifest_ref, context.planning.manifest_ref) || analysis.planning_manifest_digest !== context.planning.identity_digest) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    const storedRead = await readCommittedStageLineage(new WorkflowCheckpointStore(dependencies.database), request.operation_id, "READ_AND_EXTRACT");
    const read = decodeResearchReadExtractCheckpoint(await readWorkflowObject(dependencies.work_bucket, storedRead.receipt.output_manifest, true));
    if (!sameRef(read.checkpoint_ref, analysis.read_extract_ref)) fail("WORKFLOW_OUTPUT_CORRUPT");
    return canonicalBytes(await reconciliationCheckpoint(dependencies, context,
      { request, principal, attempt_ref, budget_receipt_ref, input_bytes }, analysis, read));
  };
  const recover = async (stage: StageRequest["stage"], request: StageRequest, principal: WorkflowPrincipal): Promise<Uint8Array | null> => {
    if (stage === "READ_AND_EXTRACT") return read_and_extract({ request, principal, input_bytes: new Uint8Array(), attempt_ref: "recovery", budget_receipt_ref: "recovery" });
    if (stage === "ANALYZE_BRANCHES" || stage === "COUNTER_SEARCH") {
      const prior = stage === "ANALYZE_BRANCHES" ? "READ_AND_EXTRACT" : "ANALYZE_BRANCHES";
      const committed = await readCommittedStageLineage(new WorkflowCheckpointStore(dependencies.database), request.operation_id, prior);
      const bytes = await readWorkflowObject(dependencies.work_bucket, committed.receipt.output_manifest, true);
      return (stage === "ANALYZE_BRANCHES" ? analyze_branches : counter_search)({
        request,
        principal,
        input_bytes: bytes,
        attempt_ref: "recovery",
        budget_receipt_ref: "recovery",
      });
    }
    return null;
  };
  return Object.freeze({ read_and_extract, analyze_branches, counter_search, recover });
}

export interface ResearchBranchReconciliationLineage {
  readonly checkpoint: ResearchBranchReconciliationCheckpoint;
  readonly read_extract_attempt_ref: string;
  readonly read_extract_request_sha256: string;
  readonly branch_analysis_attempt_ref: string;
  readonly branch_analysis_request_sha256: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
}

interface ResearchBranchReconciliationReadInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal_ref: string;
}

export async function readCommittedResearchBranchReconciliationLineage(
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

export async function readCommittedResearchBranchReconciliation(
  input: ResearchBranchReconciliationReadInput,
): Promise<ResearchBranchReconciliationCheckpoint | null> {
  const lineage = await readCommittedResearchBranchReconciliationLineage(input);
  return lineage?.checkpoint ?? null;
}
