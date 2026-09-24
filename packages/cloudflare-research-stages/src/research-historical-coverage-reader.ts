import {
  canonicalEvidenceJson, type EvidenceAccessContext,
} from "@eliotr/cloudflare-evidence";
import {
  VersionedRefSchema,
  type CoverageReceipt,
  type VersionedRef,
} from "@eliotr/contracts";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  decodeProtocolScopeCheckpoint,
  decodeResearchMaterializeResult,
  type ResearchMaterializeResultPayload,
} from "@eliotr/cloudflare-research";
import {
  fail,
  readCommittedStageLineage,
  readWorkflowObject,
  WorkflowCheckpointStore,
} from "@eliotr/cloudflare-workflows";
import { decodeResearchCoverageResult } from "./research-coverage-result.js";

const COVERAGE_STAGE = "CALCULATE_COVERAGE" as const;
const MATERIALIZE_STAGE = "MATERIALIZE" as const;
const CITATIONS_STAGE = "RESOLVE_CITATIONS" as const;
const FREEZE_STAGE = "FREEZE_PROTOCOL_AND_SCOPE" as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;

/** Current owner identity. Credential and deployment are deliberately supplied through callbacks. */
export interface HistoricalResearchCoverageOwner {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa";
}

/** The result of a fresh, independently authorized read of the Stage17 artifact. */
export interface HistoricalResearchArtifactBinding {
  readonly artifact_ref: VersionedRef;
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly status: "DRAFT";
  readonly evidence_freeze_ref: VersionedRef;
  /** Canonical `${manifest_ref.id}:${manifest_ref.revision}` from the artifact manifest. */
  readonly dependency_manifest_ref: string;
}

export interface HistoricalResearchCoverageReaderInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly operation_id: string;
  readonly owner: HistoricalResearchCoverageOwner;
  /** Rechecks the caller's current owner scope; it must not impersonate the old run. */
  readonly require_current: () => Promise<void>;
  /** Must perform artifact reauthorization and exact original-scope/source checks. */
  readonly require_artifact: (input: {
    readonly artifact_ref: VersionedRef;
    readonly original_scope_snapshot_ref: VersionedRef;
  }) => Promise<HistoricalResearchArtifactBinding>;
}

/** Recorded authorship is a lookup constraint, not an authenticated reader. */
export interface ProjectClientHistoricalCoverageReaderInput extends Omit<HistoricalResearchCoverageReaderInput, "owner"> {
  readonly reader: EvidenceAccessContext;
  readonly original_principal_ref: string;
}

export interface HistoricalResearchCoverageProvenance {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly original_credential_generation: string;
  readonly original_deployment_generation: string;
  readonly handler_generation: string;
  readonly coverage_stage_attempt_ref: string;
  readonly coverage_stage_request_sha256: string;
  readonly coverage_output_sha256: string;
  readonly materialize_stage_attempt_ref: string;
  readonly materialize_stage_request_sha256: string;
  readonly materialize_output_sha256: string;
}

export interface HistoricalResearchCoverageReadback {
  readonly protocol: "eliotr.research.historical-coverage.v1";
  readonly artifact_ref: VersionedRef;
  readonly coverage_receipt: CoverageReceipt;
  readonly coverage_receipt_ref: VersionedRef;
  readonly provenance: HistoricalResearchCoverageProvenance;
}

interface StoredRunRow {
  readonly operation_id: unknown;
  readonly investigation_id: unknown;
  readonly initial_revision: unknown;
  readonly current_revision: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly next_stage_index: unknown;
  readonly state: unknown;
  readonly handler_generation: unknown;
}

interface StoredArtifactManifestRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly principal_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly manifest_sha256: unknown;
  readonly manifest_size_bytes: unknown;
}

function corrupt(): never {
  fail("WORKFLOW_OUTPUT_CORRUPT");
}

function unavailable(): never {
  fail("WORKFLOW_OUTPUT_UNAVAILABLE");
}

function text(value: unknown, _label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) corrupt();
  return value;
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) corrupt();
  return value as number;
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

function requireObjectAuthority(
  object: { readonly residency: { readonly scope_domain_id: string; readonly access_domain_id: string } },
  scope: VersionedRef,
  principalRef: string,
): void {
  if (object.residency.scope_domain_id !== scope.id || object.residency.access_domain_id !== principalRef) corrupt();
}

function requireStageLineage(
  lineage: Awaited<ReturnType<typeof readCommittedStageLineage>>,
  stage: typeof FREEZE_STAGE | typeof CITATIONS_STAGE | typeof COVERAGE_STAGE | typeof MATERIALIZE_STAGE,
  run: {
    readonly operation_id: string;
    readonly investigation_id: string;
    readonly handler_generation: string;
    readonly scope: VersionedRef;
    readonly principal_ref: string;
  },
  expectedState: "CHECKPOINTED" | "ENGINE_COMPLETED",
): void {
  if (lineage.request.stage !== stage || lineage.request.operation_id !== run.operation_id ||
      lineage.request.investigation_ref.id !== run.investigation_id ||
      lineage.request.handler_generation !== run.handler_generation ||
      lineage.receipt.stage !== stage || lineage.receipt.operation_id !== run.operation_id ||
      lineage.receipt.engine_state !== expectedState ||
      lineage.receipt.attempt_ref !== lineage.attempt_ref ||
      lineage.receipt.request_sha256 !== lineage.request_sha256 ||
      lineage.receipt.investigation_ref.id !== run.investigation_id ||
      lineage.receipt.input_manifest_ref !== lineage.request.input_manifest.object_ref) corrupt();
  requireObjectAuthority(lineage.request.input_manifest, run.scope, run.principal_ref);
  requireObjectAuthority(lineage.receipt.output_manifest, run.scope, run.principal_ref);
}

function parseArtifactBinding(
  value: HistoricalResearchArtifactBinding,
  artifactRef: VersionedRef,
  scope: VersionedRef,
): HistoricalResearchArtifactBinding {
  if (value === null || typeof value !== "object" || value.status !== "DRAFT" ||
      !sameRef(value.artifact_ref, artifactRef) || !sameRef(value.original_scope_snapshot_ref, scope) ||
      !VersionedRefSchema.safeParse(value.evidence_freeze_ref).success ||
      typeof value.dependency_manifest_ref !== "string" || !IDENTIFIER.test(value.dependency_manifest_ref)) corrupt();
  return Object.freeze({
    artifact_ref: Object.freeze({ ...artifactRef }),
    original_scope_snapshot_ref: Object.freeze({ ...scope }),
    status: "DRAFT" as const,
    evidence_freeze_ref: Object.freeze({ ...value.evidence_freeze_ref }),
    dependency_manifest_ref: value.dependency_manifest_ref,
  });
}

/**
 * Reads immutable Stage16/17 output after the original run scope or deployment
 * has expired. Current access is supplied only by the two callbacks; persisted
 * run credential/deployment values are returned as provenance and never used to
 * construct a principal or grant.
 */
export async function readHistoricalResearchCoverage(
  input: HistoricalResearchCoverageReaderInput,
): Promise<HistoricalResearchCoverageReadback | null> {
  if (input === null || typeof input !== "object" || input.owner?.client_class !== "owner_pwa") {
    fail("WORKFLOW_INPUT_INVALID");
  }
  return readHistoricalCoverage(input, input.owner.principal_ref);
}

/** The composed callbacks must authorize the actual service for this exact run
 * and artifact. No stored credential is promoted into a reader identity. */
export async function readProjectClientHistoricalResearchCoverage(
  input: ProjectClientHistoricalCoverageReaderInput,
): Promise<HistoricalResearchCoverageReadback | null> {
  if (input === null || typeof input !== "object" ||
      (input.reader?.client_class !== "trusted_agent" && input.reader?.client_class !== "named_api_client") ||
      typeof input.reader.principal_ref !== "string" || !IDENTIFIER.test(input.reader.principal_ref) ||
      typeof input.reader.credential_generation !== "string" || !IDENTIFIER.test(input.reader.credential_generation)) {
    fail("WORKFLOW_INPUT_INVALID");
  }
  return readHistoricalCoverage(input, input.original_principal_ref);
}

/** The current owner is not the recorded machine author. Entitlement is checked
 * independently before using that author solely as a historical lookup key. */
export async function readOwnerMachineHistoricalResearchCoverage(
  input: HistoricalResearchCoverageReaderInput & { readonly original_principal_ref: string },
): Promise<HistoricalResearchCoverageReadback | null> {
  if (input === null || typeof input !== "object" || input.owner?.client_class !== "owner_pwa" ||
      typeof input.owner.principal_ref !== "string" || !IDENTIFIER.test(input.owner.principal_ref) ||
      typeof input.original_principal_ref !== "string" || !IDENTIFIER.test(input.original_principal_ref)) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  const requireOrigin = async () => {
    await input.require_current();
    const origin = await input.database.prepare("SELECT 1 AS present FROM owner_machine_run_origin " +
      "WHERE operation_id=?1 AND principal_ref=?2 AND reader_principal_ref=?3 LIMIT 1")
      .bind(input.operation_id, input.original_principal_ref, input.owner.principal_ref).first();
    if (origin === null) fail("WORKFLOW_AUTHORITY_STALE");
  };
  await requireOrigin();
  const result = await readHistoricalCoverage({ ...input, require_current: requireOrigin }, input.original_principal_ref);
  await requireOrigin();
  return result;
}

async function readHistoricalCoverage(
  input: Omit<HistoricalResearchCoverageReaderInput, "owner">,
  originalPrincipal: string,
): Promise<HistoricalResearchCoverageReadback | null> {
  if (typeof originalPrincipal !== "string" || !IDENTIFIER.test(originalPrincipal) ||
      typeof input.operation_id !== "string" || !IDENTIFIER.test(input.operation_id) ||
      typeof input.require_current !== "function" || typeof input.require_artifact !== "function") {
    fail("WORKFLOW_INPUT_INVALID");
  }

  await input.require_current();
  let row: StoredRunRow | null;
  try {
    row = await input.database.prepare(
      "SELECT operation_id, investigation_id, initial_revision, current_revision, principal_ref, " +
      "credential_generation, deployment_generation, scope_snapshot_id, scope_snapshot_revision, " +
      "next_stage_index, state, handler_generation FROM research_workflow_run " +
      "WHERE operation_id=?1 AND principal_ref=?2 LIMIT 1",
    ).bind(input.operation_id, originalPrincipal).first<StoredRunRow>();
  } catch {
    unavailable();
  }
  if (row === null) return null;

  const operationId = text(row.operation_id, "operation_id");
  const investigationId = text(row.investigation_id, "investigation_id");
  const principalRef = text(row.principal_ref, "principal_ref");
  const credentialGeneration = text(row.credential_generation, "credential_generation");
  const deploymentGeneration = text(row.deployment_generation, "deployment_generation");
  const scope = VersionedRefSchema.parse({ id: text(row.scope_snapshot_id, "scope_snapshot_id"), revision: positive(row.scope_snapshot_revision) });
  const initialRevision = positive(row.initial_revision);
  const currentRevision = positive(row.current_revision);
  const nextStageIndex = Number(row.next_stage_index);
  const handlerGeneration = text(row.handler_generation, "handler_generation");
  if (operationId !== input.operation_id || principalRef !== originalPrincipal ||
      row.state !== "ENGINE_COMPLETED" || nextStageIndex !== RESEARCH_WORKFLOW_STAGES.length ||
      currentRevision !== initialRevision + nextStageIndex) return null;

  const run = { operation_id: operationId, investigation_id: investigationId, handler_generation: handlerGeneration, scope, principal_ref: principalRef } as const;
  const checkpoints = new WorkflowCheckpointStore(input.database);
  const freeze = await readCommittedStageLineage(checkpoints, operationId, FREEZE_STAGE);
  const citations = await readCommittedStageLineage(checkpoints, operationId, CITATIONS_STAGE);
  const coverageLineage = await readCommittedStageLineage(checkpoints, operationId, COVERAGE_STAGE);
  const materialize = await readCommittedStageLineage(checkpoints, operationId, MATERIALIZE_STAGE);
  requireStageLineage(freeze, FREEZE_STAGE, run, "CHECKPOINTED");
  requireStageLineage(citations, CITATIONS_STAGE, run, "CHECKPOINTED");
  requireStageLineage(coverageLineage, COVERAGE_STAGE, run, "CHECKPOINTED");
  requireStageLineage(materialize, MATERIALIZE_STAGE, run, "ENGINE_COMPLETED");
  if (!sameJson(coverageLineage.request.input_manifest, citations.receipt.output_manifest) ||
      !sameJson(materialize.request.input_manifest, coverageLineage.receipt.output_manifest) ||
      coverageLineage.receipt.investigation_ref.revision !== materialize.request.investigation_ref.revision ||
      citations.receipt.investigation_ref.revision !== coverageLineage.request.investigation_ref.revision ||
      materialize.receipt.investigation_ref.revision !== currentRevision ||
      materialize.request.investigation_ref.revision + 1 !== materialize.receipt.investigation_ref.revision) corrupt();

  const coverageBytes = await readWorkflowObject(input.work_bucket, coverageLineage.receipt.output_manifest, true);
  const coverage = await decodeResearchCoverageResult(coverageBytes);
  if (coverage.operation_id !== operationId || coverage.stage !== COVERAGE_STAGE ||
      !sameRef(coverage.investigation_ref, coverageLineage.request.investigation_ref) ||
      coverage.stage_attempt_ref !== coverageLineage.attempt_ref ||
      coverage.stage_request_sha256 !== coverageLineage.request_sha256 ||
      coverage.stage_fifteen.operation_id !== operationId ||
      coverage.stage_fifteen.stage !== CITATIONS_STAGE ||
      !sameRef(coverage.stage_fifteen.investigation_ref, citations.request.investigation_ref) ||
      coverage.stage_fifteen.stage_attempt_ref !== citations.attempt_ref ||
      coverage.stage_fifteen.stage_request_sha256 !== citations.request_sha256 ||
      coverage.stage_fifteen.output_sha256 !== citations.receipt.output_manifest.sha256 ||
      !sameRef(coverage.scope_snapshot_ref, scope) ||
      !sameRef(coverage.coverage_receipt.frozen_scope_snapshot_ref, scope)) corrupt();

  const freezeBytes = await readWorkflowObject(input.work_bucket, freeze.receipt.output_manifest, true);
  const protocol = decodeProtocolScopeCheckpoint(freezeBytes);
  if (protocol.operation_id !== operationId || protocol.principal_ref !== principalRef ||
      protocol.attempt_ref !== freeze.attempt_ref ||
      protocol.investigation_ref.revision !== freeze.request.investigation_ref.revision ||
      !sameRef(protocol.scope_snapshot_ref, scope) ||
      protocol.investigation_ref.id !== investigationId ||
      !sameRef(protocol.coverage_denominator.denominator_ref, coverage.coverage_receipt.coverage_denominator_ref)) corrupt();

  const materializeBytes = await readWorkflowObject(input.work_bucket, materialize.receipt.output_manifest, true);
  const materialized: ResearchMaterializeResultPayload = decodeResearchMaterializeResult(materializeBytes);
  if (materialized.operation_id !== operationId || materialized.stage !== MATERIALIZE_STAGE ||
      materialized.stage_attempt_ref !== materialize.attempt_ref ||
      materialized.stage_request_sha256 !== materialize.request_sha256) corrupt();

  const artifactRef = VersionedRefSchema.parse(materialized.draft.artifact_ref);
  const artifact = await input.require_artifact({ artifact_ref: artifactRef, original_scope_snapshot_ref: scope });
  const artifactBinding = parseArtifactBinding(artifact, artifactRef, scope);
  if (!sameRef(coverage.freeze_ref, artifactBinding.evidence_freeze_ref) ||
      refKey(coverage.manifest_ref) !== artifactBinding.dependency_manifest_ref) corrupt();
  let artifactManifest: StoredArtifactManifestRow | null;
  try {
    artifactManifest = await input.database.prepare(
      "SELECT artifact_id, revision, principal_ref, scope_snapshot_id, scope_snapshot_revision, " +
      "manifest_r2_key, manifest_sha256, manifest_size_bytes FROM artifact_draft_binding " +
      "WHERE artifact_id=?1 AND revision=?2 AND principal_ref=?3 AND scope_snapshot_id=?4 " +
      "AND scope_snapshot_revision=?5 LIMIT 1",
    ).bind(artifactRef.id, artifactRef.revision, originalPrincipal, scope.id, scope.revision).first<StoredArtifactManifestRow>();
  } catch {
    unavailable();
  }
  if (artifactManifest === null ||
      artifactManifest.artifact_id !== artifactRef.id || artifactManifest.revision !== artifactRef.revision ||
      artifactManifest.principal_ref !== originalPrincipal ||
      artifactManifest.scope_snapshot_id !== scope.id || artifactManifest.scope_snapshot_revision !== scope.revision ||
      artifactManifest.manifest_r2_key !== materialized.draft.manifest.key ||
      artifactManifest.manifest_sha256 !== materialized.draft.manifest.sha256 ||
      artifactManifest.manifest_size_bytes !== materialized.draft.manifest.size_bytes) corrupt();
  await input.require_current();
  return Object.freeze({
    protocol: "eliotr.research.historical-coverage.v1" as const,
    artifact_ref: Object.freeze({ ...artifactRef }),
    coverage_receipt: coverage.coverage_receipt,
    coverage_receipt_ref: Object.freeze({ ...coverage.coverage_receipt.receipt_ref }),
    provenance: Object.freeze({
      operation_id: operationId,
      investigation_ref: Object.freeze({ ...materialize.receipt.investigation_ref }),
      original_scope_snapshot_ref: Object.freeze({ ...scope }),
      original_credential_generation: credentialGeneration,
      original_deployment_generation: deploymentGeneration,
      handler_generation: handlerGeneration,
      coverage_stage_attempt_ref: coverageLineage.attempt_ref,
      coverage_stage_request_sha256: coverageLineage.request_sha256,
      coverage_output_sha256: coverageLineage.receipt.output_manifest.sha256,
      materialize_stage_attempt_ref: materialize.attempt_ref,
      materialize_stage_request_sha256: materialize.request_sha256,
      materialize_output_sha256: materialize.receipt.output_manifest.sha256,
    }),
  });
}
