import {
  canonicalEvidenceJson,
} from "@eliotr/cloudflare-evidence";
import type {
  CoverageReceipt,
  VersionedRef,
} from "@eliotr/contracts";
import type {
  ResearchRunResult,
} from "@eliotr/research";
import {
  decodeProtocolScopeCheckpoint,
  readCommittedResearchMaterializeOutput,
  type ResearchMaterializeOutputReadback,
  type ResearchMaterializeOutputReaderInput,
  type RunStatusAuthoritySnapshot,
} from "@eliotr/cloudflare-research";
import {
  fail,
  readCommittedStageLineage,
  readWorkflowObject,
  snapshotPrincipal,
  WorkflowCheckpointStore,
  type StageRequest,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import { decodeResearchCoverageResult } from "./research-coverage-result.js";

const STAGE_ZERO = "FREEZE_PROTOCOL_AND_SCOPE" as const;
const STAGE_FIFTEEN = "RESOLVE_CITATIONS" as const;
const STAGE_SIXTEEN = "CALCULATE_COVERAGE" as const;
const STAGE_MATERIALIZE = "MATERIALIZE" as const;

export type ResearchRunResultReaderInput = ResearchMaterializeOutputReaderInput;

/**
 * The public result is intentionally small.  The committed coverage and
 * materialization readbacks are retained for callers that need to disclose
 * their durable provenance without rereading or re-running a stage.
 */
export interface ResearchRunResultReadback extends ResearchRunResult {
  readonly coverage_receipt: CoverageReceipt;
  readonly materialization: ResearchMaterializeOutputReadback;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function failAuthority(): never {
  fail("WORKFLOW_AUTHORITY_STALE");
}

function failCorrupt(): never {
  fail("WORKFLOW_OUTPUT_CORRUPT");
}

function requireObjectAuthority(
  object: StageRequest["input_manifest"],
  scopeSnapshotId: string,
  principalRef: string,
): void {
  if (object.residency.scope_domain_id !== scopeSnapshotId ||
      object.residency.access_domain_id !== principalRef) {
    failAuthority();
  }
}

function requireAuthority(
  snapshot: RunStatusAuthoritySnapshot,
  expected: RunStatusAuthoritySnapshot,
): void {
  if (snapshot.investigation_id !== expected.investigation_id ||
      snapshot.scope_snapshot_id !== expected.scope_snapshot_id ||
      snapshot.scope_snapshot_revision !== expected.scope_snapshot_revision) {
    failAuthority();
  }
}

function requireStageRequest(
  request: StageRequest,
  stage: StageRequest["stage"],
  operationId: string,
  investigationId: string,
  handlerGeneration: string,
  scopeSnapshotId: string,
  principalRef: string,
): void {
  if (request.stage !== stage || request.operation_id !== operationId ||
      request.investigation_ref.id !== investigationId ||
      request.handler_generation !== handlerGeneration) {
    failCorrupt();
  }
  requireObjectAuthority(request.input_manifest, scopeSnapshotId, principalRef);
}

function requireCheckpointState(
  lineage: Awaited<ReturnType<typeof readCommittedStageLineage>>,
  stage: StageRequest["stage"],
  expectedState: "CHECKPOINTED" | "ENGINE_COMPLETED",
  operationId: string,
  investigationId: string,
  handlerGeneration: string,
  scopeSnapshotId: string,
  principalRef: string,
): void {
  requireStageRequest(
    lineage.request,
    stage,
    operationId,
    investigationId,
    handlerGeneration,
    scopeSnapshotId,
    principalRef,
  );
  if (lineage.receipt.engine_state !== expectedState ||
      lineage.receipt.input_manifest_ref !== lineage.request.input_manifest.object_ref ||
      lineage.receipt.investigation_ref.id !== investigationId ||
      lineage.receipt.attempt_ref !== lineage.attempt_ref ||
      lineage.receipt.request_sha256 !== lineage.request_sha256) {
    failCorrupt();
  }
  requireObjectAuthority(lineage.receipt.output_manifest, scopeSnapshotId, principalRef);
}

function requireMaterializationBinding(
  materialization: ResearchMaterializeOutputReadback,
  lineage: Awaited<ReturnType<typeof readCommittedStageLineage>>,
  stageSixteen: Awaited<ReturnType<typeof readCommittedStageLineage>>,
  scopeSnapshotId: string,
  principalRef: string,
): void {
  if (!sameJson(lineage.receipt, materialization.workflow_receipt) ||
      materialization.materialization.operation_id !== lineage.request.operation_id ||
      materialization.materialization.stage_attempt_ref !== lineage.attempt_ref ||
      materialization.materialization.stage_request_sha256 !== lineage.request_sha256 ||
      !sameJson(lineage.request.input_manifest, stageSixteen.receipt.output_manifest) ||
      !sameRef(materialization.investigation_ref, lineage.receipt.investigation_ref)) {
    failCorrupt();
  }
  requireObjectAuthority(lineage.request.input_manifest, scopeSnapshotId, principalRef);
}

function requireCoverageBinding(
  result: Awaited<ReturnType<typeof decodeResearchCoverageResult>>,
  stageSixteen: Awaited<ReturnType<typeof readCommittedStageLineage>>,
  stageFifteen: Awaited<ReturnType<typeof readCommittedStageLineage>>,
  materialization: ResearchMaterializeOutputReadback,
  scopeSnapshotId: string,
  principalRef: string,
): void {
  const request = stageSixteen.request;
  const receipt = stageSixteen.receipt;
  const citations = result.stage_fifteen;
  if (result.operation_id !== request.operation_id ||
      result.investigation_ref.id !== request.investigation_ref.id ||
      result.investigation_ref.revision !== request.investigation_ref.revision ||
      result.stage !== STAGE_SIXTEEN ||
      result.stage_attempt_ref !== stageSixteen.attempt_ref ||
      result.stage_request_sha256 !== stageSixteen.request_sha256 ||
      receipt.input_manifest_ref !== request.input_manifest.object_ref ||
      !sameJson(request.input_manifest, stageFifteen.receipt.output_manifest) ||
      citations.operation_id !== stageFifteen.request.operation_id ||
      !sameRef(citations.investigation_ref, stageFifteen.request.investigation_ref) ||
      citations.stage_attempt_ref !== stageFifteen.attempt_ref ||
      citations.stage_request_sha256 !== stageFifteen.request_sha256 ||
      citations.output_sha256 !== stageFifteen.receipt.output_manifest.sha256 ||
      !sameRef(result.coverage_receipt.frozen_scope_snapshot_ref, result.scope_snapshot_ref) ||
      result.scope_snapshot_ref.id !== scopeSnapshotId ||
      !sameRef(materialization.artifact.evidence_freeze_ref, result.freeze_ref) ||
      materialization.artifact.dependency_manifest_ref !== refKey(result.manifest_ref)) {
    failCorrupt();
  }
  requireObjectAuthority(request.input_manifest, scopeSnapshotId, principalRef);
  requireObjectAuthority(receipt.output_manifest, scopeSnapshotId, principalRef);
}

function requireProtocolBinding(
  protocol: ReturnType<typeof decodeProtocolScopeCheckpoint>,
  stageZero: Awaited<ReturnType<typeof readCommittedStageLineage>>,
  operationId: string,
  investigationId: string,
  principal: WorkflowPrincipal,
  scopeSnapshotId: string,
  scopeSnapshotRevision: number,
): void {
  if (protocol.operation_id !== operationId ||
      protocol.attempt_ref !== stageZero.attempt_ref ||
      protocol.investigation_ref.id !== stageZero.request.investigation_ref.id ||
      protocol.principal_ref !== principal.principal_ref ||
      protocol.scope_snapshot_ref.id !== scopeSnapshotId ||
      protocol.scope_snapshot_ref.revision !== scopeSnapshotRevision ||
      stageZero.request.investigation_ref.revision !== protocol.investigation_ref.revision ||
      stageZero.receipt.investigation_ref.id !== investigationId) {
    failAuthority();
  }
}

/**
 * Reads the final server-owned exploratory result after native MATERIALIZE
 * completion.  A legacy generation or a run without committed materialization
 * keeps the existing reader's null result; a matching v3 run with broken
 * Stage16 lineage fails closed as corrupt.
 */
export async function readCommittedResearchRunResult(
  input: ResearchRunResultReaderInput,
): Promise<ResearchRunResultReadback | null> {
  if (input === null || typeof input !== "object" ||
      typeof input.recheck_authority !== "function") {
    fail("WORKFLOW_INPUT_INVALID");
  }
  const principal = snapshotPrincipal(input.principal);
  const frozenInput: ResearchRunResultReaderInput = Object.freeze({
    ...input,
    principal,
  });
  const materialization = await readCommittedResearchMaterializeOutput(frozenInput);
  if (materialization === null) return null;

  const operationId = frozenInput.operation_id;
  const handlerGeneration = frozenInput.materialize_handler_generation;
  const investigationId = materialization.investigation_ref.id;
  const checkpoints = new WorkflowCheckpointStore(frozenInput.database);
  const authorityBefore = await frozenInput.recheck_authority();
  const scopeSnapshotId = authorityBefore.scope_snapshot_id;
  const scopeSnapshotRevision = authorityBefore.scope_snapshot_revision;

  const materialize = await readCommittedStageLineage(checkpoints, operationId, STAGE_MATERIALIZE);
  requireCheckpointState(
    materialize,
    STAGE_MATERIALIZE,
    "ENGINE_COMPLETED",
    operationId,
    investigationId,
    handlerGeneration,
    scopeSnapshotId,
    principal.principal_ref,
  );
  const stageSixteen = await readCommittedStageLineage(checkpoints, operationId, STAGE_SIXTEEN);
  requireCheckpointState(
    stageSixteen,
    STAGE_SIXTEEN,
    "CHECKPOINTED",
    operationId,
    investigationId,
    handlerGeneration,
    scopeSnapshotId,
    principal.principal_ref,
  );
  const stageFifteen = await readCommittedStageLineage(checkpoints, operationId, STAGE_FIFTEEN);
  requireCheckpointState(
    stageFifteen,
    STAGE_FIFTEEN,
    "CHECKPOINTED",
    operationId,
    investigationId,
    handlerGeneration,
    scopeSnapshotId,
    principal.principal_ref,
  );
  const stageZero = await readCommittedStageLineage(checkpoints, operationId, STAGE_ZERO);
  requireCheckpointState(
    stageZero,
    STAGE_ZERO,
    "CHECKPOINTED",
    operationId,
    investigationId,
    handlerGeneration,
    scopeSnapshotId,
    principal.principal_ref,
  );

  requireMaterializationBinding(
    materialization,
    materialize,
    stageSixteen,
    scopeSnapshotId,
    principal.principal_ref,
  );
  if (!sameRef(materialize.request.investigation_ref, stageSixteen.receipt.investigation_ref) ||
      !sameRef(stageSixteen.receipt.investigation_ref, materialize.request.investigation_ref) ||
      stageSixteen.receipt.investigation_ref.revision !== materialization.workflow_receipt.investigation_ref.revision ||
      stageSixteen.request.investigation_ref.revision + 1 !== stageSixteen.receipt.investigation_ref.revision ||
      stageFifteen.receipt.investigation_ref.revision !== stageSixteen.request.investigation_ref.revision ||
      stageFifteen.request.investigation_ref.revision + 1 !== stageFifteen.receipt.investigation_ref.revision ||
      !sameJson(stageSixteen.request.input_manifest, stageFifteen.receipt.output_manifest)) {
    failCorrupt();
  }

  const stageSixteenBytes = await readWorkflowObject(frozenInput.work_bucket, stageSixteen.receipt.output_manifest, true);
  const coverage = await decodeResearchCoverageResult(stageSixteenBytes);
  requireCoverageBinding(
    coverage,
    stageSixteen,
    stageFifteen,
    materialization,
    scopeSnapshotId,
    principal.principal_ref,
  );

  const stageZeroBytes = await readWorkflowObject(frozenInput.work_bucket, stageZero.receipt.output_manifest, true);
  const protocol = decodeProtocolScopeCheckpoint(stageZeroBytes);
  requireProtocolBinding(
    protocol,
    stageZero,
    operationId,
    investigationId,
    principal,
    scopeSnapshotId,
    scopeSnapshotRevision,
  );
  if (protocol.coverage_denominator.denominator_ref.id !== coverage.coverage_receipt.coverage_denominator_ref.id ||
      protocol.coverage_denominator.denominator_ref.revision !== coverage.coverage_receipt.coverage_denominator_ref.revision ||
      !sameRef(protocol.scope_snapshot_ref, coverage.scope_snapshot_ref)) {
    failCorrupt();
  }

  const authorityAfter = await frozenInput.recheck_authority();
  requireAuthority(authorityAfter, authorityBefore);
  const coverageReceipt = coverage.coverage_receipt;
  return Object.freeze({
    investigation_ref: Object.freeze({ ...materialization.investigation_ref }),
    artifact_refs: Object.freeze([Object.freeze({ ...materialization.materialization.draft.artifact_ref })]),
    coverage_receipt_ref: Object.freeze({ ...coverageReceipt.receipt_ref }),
    completion_disposition: coverageReceipt.terminal_disposition,
    reopen_conditions: Object.freeze([...protocol.protocol_profile.reopen_conditions]),
    coverage_receipt: coverageReceipt,
    materialization,
  });
}
