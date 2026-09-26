import {
  ResearchBranchEvidenceItemSchema,
  parseResearchPlanningManifest,
  type ResearchBranchEvidenceItem,
  type ResearchPlanningManifest,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore, LedgerHead } from "@eliotr/research";
import {
  WorkflowCheckpointStore,
  WorkflowObjectSchema,
  fail,
  readWorkflowObject,
  type StageRequest,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import { assertResearchPlanningManifestIdentity } from "./research-planning-manifest.js";
import type { EvidenceFreezeStageFiveLineage } from "./research-evidence-freeze-preparation.js";
import { readFreezeProtocolAndScopeCheckpoint, type ProtocolScopeCheckpoint } from "./research-protocol-freeze.js";
import { refKey, sameRef } from "./research-branch-execution-shared.js";

interface InitialPayload {
  readonly planning_manifest?: unknown;
}

export interface BranchExecutionContext {
  readonly protocol: ProtocolScopeCheckpoint;
  readonly planning: ResearchPlanningManifest;
  readonly w1: LedgerHead;
  readonly stage_five: EvidenceFreezeStageFiveLineage;
}

export interface ResearchBranchExecutionDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly read_stage_five: (input: {
    readonly operation_id: string;
    readonly investigation_id: string;
    readonly principal: WorkflowPrincipal;
  }) => Promise<EvidenceFreezeStageFiveLineage>;
}

async function loadPlanningManifest(
  database: D1Database,
  bucket: R2Bucket,
  operationId: string,
): Promise<ResearchPlanningManifest> {
  const row = await database.prepare(
    "SELECT initial_manifest_json FROM research_workflow_run WHERE operation_id=?1 LIMIT 1",
  ).bind(operationId).first<{ readonly initial_manifest_json: string }>();
  if (row === null) fail("WORKFLOW_OUTPUT_CORRUPT");
  let object;
  try { object = WorkflowObjectSchema.parse(JSON.parse(row.initial_manifest_json)); }
  catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
  const bytes = await readWorkflowObject(bucket, object, false);
  let payload: InitialPayload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as InitialPayload; }
  catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
  if (payload.planning_manifest === undefined) fail("WORKFLOW_AUTHORITY_STALE");
  try { return assertResearchPlanningManifestIdentity(parseResearchPlanningManifest(payload.planning_manifest)); }
  catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
}

export async function loadContext(
  dependencies: ResearchBranchExecutionDependencies,
  request: StageRequest,
  principal: WorkflowPrincipal,
): Promise<BranchExecutionContext> {
  const before = await dependencies.navigation.current();
  const checkpoints = new WorkflowCheckpointStore(dependencies.database);
  const storedZero = await checkpoints.readCommittedStageRequest(request.operation_id, "FREEZE_PROTOCOL_AND_SCOPE");
  if (storedZero === null || storedZero.request.investigation_ref.id !== request.investigation_ref.id) fail("WORKFLOW_AUTHORITY_STALE");
  const protocol = await readFreezeProtocolAndScopeCheckpoint({
    request: storedZero.request,
    principal,
    database: dependencies.database,
    bucket: dependencies.work_bucket,
    navigation: dependencies.navigation,
    ledger: dependencies.ledger,
    expected_attempt_ref: storedZero.attempt_ref,
  });
  const planning = await loadPlanningManifest(dependencies.database, dependencies.work_bucket, request.operation_id);
  const stageFive = await dependencies.read_stage_five({
    operation_id: request.operation_id,
    investigation_id: request.investigation_ref.id,
    principal,
  });
  const w1 = await dependencies.ledger.read(request.investigation_ref.id);
  if (w1 === null || w1.head.revision !== request.investigation_ref.revision || w1.head.principal_ref !== principal.principal_ref ||
      protocol.operation_id !== request.operation_id || protocol.principal_ref !== principal.principal_ref ||
      protocol.planning_manifest_ref === undefined || protocol.planning_manifest_digest === undefined ||
      !sameRef(protocol.planning_manifest_ref, planning.manifest_ref) || protocol.planning_manifest_digest !== planning.identity_digest ||
      planning.operation_id !== request.operation_id || planning.investigation_id !== request.investigation_ref.id ||
      !sameRef(planning.scope_snapshot_ref, protocol.scope_snapshot_ref) ||
      !sameRef(planning.inquiry_protocol_ref, protocol.profile_definition_ref) ||
      stageFive.operation_id !== request.operation_id || stageFive.investigation_ref.id !== request.investigation_ref.id ||
      stageFive.principal_ref !== principal.principal_ref || !sameRef(stageFive.scope_snapshot_ref, protocol.scope_snapshot_ref) ||
      stageFive.protocol_digest !== protocol.protocol_digest) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  if (dependencies.navigation.scope.snapshot_id !== protocol.scope_snapshot_ref.id ||
      dependencies.navigation.scope.revision !== protocol.scope_snapshot_ref.revision) fail("WORKFLOW_AUTHORITY_STALE");
  const after = await dependencies.navigation.current();
  const finalW1 = await dependencies.ledger.read(request.investigation_ref.id);
  if (finalW1 === null || canonicalEvidenceJson(before) !== canonicalEvidenceJson(after) ||
      canonicalEvidenceJson(w1.head) !== canonicalEvidenceJson(finalW1.head)) fail("WORKFLOW_AUTHORITY_STALE");
  return { protocol, planning, w1: w1.head, stage_five: stageFive };
}

export function branchEvidence(context: BranchExecutionContext): ResearchBranchEvidenceItem[] {
  const members = new Map(context.planning.source_portfolio.members.map((item) => [item.source_revision_ref, item]));
  const evidence = context.stage_five.evidence_pack.resolved_evidence.map((item) => {
    const member = members.get(item.handle.source_revision_ref);
    if (member === undefined || item.handle.terminal_state !== "LIVE" ||
        !sameRef(item.handle.scope_snapshot_ref, context.protocol.scope_snapshot_ref)) fail("WORKFLOW_OUTPUT_CORRUPT");
    return ResearchBranchEvidenceItemSchema.parse({
      handle_ref: item.handle.handle_ref,
      source_revision_ref: item.handle.source_revision_ref,
      source_id: member.source_id,
      source_class: member.source_class,
      source_namespace_id: member.source_namespace_id,
      source_owner_generation: member.source_owner_generation,
      source_family_ref: member.source_family_ref,
      independence: member.independence,
      excerpt_sha256: item.handle.excerpt_sha256,
      excerpt_byte_length: item.handle.excerpt_byte_length,
      verification_receipt_ref: item.verification_receipt_ref,
      authorization_receipt_ref: item.authorization_receipt_ref,
    });
  });
  evidence.sort((left, right) => refKey(left.handle_ref).localeCompare(refKey(right.handle_ref)));
  return evidence;
}
