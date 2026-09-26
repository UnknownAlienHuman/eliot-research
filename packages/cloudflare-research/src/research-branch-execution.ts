import {
  ResearchBranchAnalysisCheckpointSchema,
  ResearchBranchReconciliationCheckpointSchema,
  ResearchBranchRoleSchema,
  ResearchReadExtractCheckpointSchema,
  type ResearchBranchAnalysisCheckpoint,
  type ResearchBranchReconciliationCheckpoint,
  type ResearchBranchResult,
  type ResearchDebt,
  type ResearchReadExtractCheckpoint,
} from "@eliotr/contracts";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
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
import { buildRoleResult, debtFor } from "./research-branch-execution-results.js";

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

async function analyzeCheckpoint(
  context: BranchExecutionContext,
  read: ResearchReadExtractCheckpoint,
): Promise<ResearchBranchAnalysisCheckpoint> {
  const requiredRoles = uniqueSorted(context.planning.required_branch_roles.map((role) => ResearchBranchRoleSchema.parse(role)));
  const analysisRoles = requiredRoles.filter((role) => role !== "COUNTER");
  const results: ResearchBranchResult[] = [];
  for (const role of analysisRoles) results.push(await buildRoleResult(context.planning, role, read.evidence));
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
  context: BranchExecutionContext,
  analysis: ResearchBranchAnalysisCheckpoint,
  read: ResearchReadExtractCheckpoint,
): Promise<ResearchBranchReconciliationCheckpoint> {
  const results = [...analysis.branch_results];
  const counterRequired = analysis.required_roles.includes("COUNTER");
  if (counterRequired) results.push(await buildRoleResult(context.planning, "COUNTER", read.evidence));
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
  const analyze_branches: WorkflowStageHandler = async ({ request, principal, input_bytes }) => {
    if (request.stage !== "ANALYZE_BRANCHES") fail("WORKFLOW_INPUT_INVALID");
    const context = await loadContext(dependencies, request, principal);
    const read = decodeResearchReadExtractCheckpoint(input_bytes);
    if (read.operation_id !== request.operation_id || read.investigation_ref.id !== request.investigation_ref.id ||
        read.principal_ref !== principal.principal_ref || !sameRef(read.scope_snapshot_ref, context.protocol.scope_snapshot_ref) ||
        !sameRef(read.planning_manifest_ref, context.planning.manifest_ref) || read.planning_manifest_digest !== context.planning.identity_digest) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    return canonicalBytes(await analyzeCheckpoint(context, read));
  };
  const counter_search: WorkflowStageHandler = async ({ request, principal, input_bytes }) => {
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
    return canonicalBytes(await reconciliationCheckpoint(context, analysis, read));
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

export async function readCommittedResearchBranchReconciliation(input: {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal_ref: string;
}): Promise<ResearchBranchReconciliationCheckpoint | null> {
  const checkpoints = new WorkflowCheckpointStore(input.database);
  const committed = await checkpoints.readCommittedStageRequest(input.operation_id, "COUNTER_SEARCH");
  if (committed === null || committed.request.investigation_ref.id !== input.investigation_id) return null;
  const receipt = await checkpoints.receipt(committed.request, committed.request_sha256);
  if (receipt === null || receipt.attempt_ref !== committed.attempt_ref) fail("WORKFLOW_OUTPUT_CORRUPT");
  const parsed = decodeResearchBranchReconciliationCheckpoint(await readWorkflowObject(input.work_bucket, receipt.output_manifest, true));
  if (parsed.operation_id !== input.operation_id || parsed.investigation_ref.id !== input.investigation_id ||
      parsed.principal_ref !== input.principal_ref) fail("WORKFLOW_OUTPUT_CORRUPT");
  return parsed;
}
