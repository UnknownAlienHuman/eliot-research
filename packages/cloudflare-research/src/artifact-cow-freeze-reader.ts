import { EvidenceFreezeSchema, VersionedRefSchema, type EvidenceFreeze, type VersionedRef } from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { digest, readWorkflowObject, WorkflowCheckpointStore, readCommittedStageLineage } from "@eliotr/cloudflare-workflows";
import { decodeEvidenceFreezeStageInput } from "./research-evidence-freeze.js";

interface OriginRow {
  readonly operation_id: unknown;
  readonly investigation_id: unknown;
  readonly freeze_id: unknown;
  readonly freeze_revision: unknown;
}

export interface ArtifactCowHistoricalFreeze {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly freeze: EvidenceFreeze;
  readonly freeze_sha256: string;
}

function fail(message: string): never {
  throw new Error(`ARTIFACT_COW_FREEZE_LINEAGE_INVALID: ${message}`);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

/**
 * Reads the immutable freeze from the original REPORT's committed W2 lineage.
 * Historical freeze credentials are deliberately not compared to current
 * credentials; callers separately reauthorize all evidence under current
 * owner authority before reuse or model execution.
 */
export async function readArtifactCowHistoricalFreeze(input: {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly artifact_ref: VersionedRef;
  readonly expected_freeze_ref: VersionedRef;
  readonly expected_scope_snapshot_ref: VersionedRef;
}): Promise<ArtifactCowHistoricalFreeze> {
  const artifactRef = VersionedRefSchema.parse(input.artifact_ref);
  const freezeRef = VersionedRefSchema.parse(input.expected_freeze_ref);
  const scopeRef = VersionedRefSchema.parse(input.expected_scope_snapshot_ref);
  const matches = await input.database.prepare(
    "SELECT ra.operation_id,wr.investigation_id,a.evidence_freeze_id AS freeze_id,a.evidence_freeze_revision AS freeze_revision " +
      "FROM artifact_revision a " +
      "JOIN artifact_draft_binding b ON (b.artifact_id,b.revision)=(a.artifact_id,a.revision) " +
      "JOIN research_report_admission ra ON ra.intent_id=b.intent_id AND ra.intent_revision=b.intent_revision " +
      "JOIN research_workflow_run wr ON wr.operation_id=ra.operation_id " +
      "WHERE a.artifact_id=?1 AND a.revision=?2 AND a.evidence_freeze_id=?3 AND a.evidence_freeze_revision=?4 LIMIT 2",
  ).bind(artifactRef.id, artifactRef.revision, freezeRef.id, freezeRef.revision)
    .all<OriginRow>();
  if (matches.success !== true || !Array.isArray(matches.results) || matches.results.length !== 1) {
    fail("exact draft intent does not resolve to one historical REPORT freeze lineage");
  }
  const row = matches.results[0];
  if (row === undefined || typeof row.operation_id !== "string" || typeof row.investigation_id !== "string" ||
      row.freeze_id !== freezeRef.id || row.freeze_revision !== freezeRef.revision) {
    fail("historical freeze origin row is malformed");
  }

  const checkpoints = new WorkflowCheckpointStore(input.database);
  const [reconcile, frozen] = await Promise.all([
    readCommittedStageLineage(checkpoints, row.operation_id, "RECONCILE"),
    readCommittedStageLineage(checkpoints, row.operation_id, "FREEZE_EVIDENCE"),
  ]);
  if (reconcile.request.operation_id !== row.operation_id || frozen.request.operation_id !== row.operation_id ||
      reconcile.request.stage !== "RECONCILE" || frozen.request.stage !== "FREEZE_EVIDENCE" ||
      reconcile.request.investigation_ref.id !== row.investigation_id || frozen.request.investigation_ref.id !== row.investigation_id ||
      reconcile.receipt.investigation_ref.id !== row.investigation_id || frozen.receipt.investigation_ref.id !== row.investigation_id ||
      frozen.request.input_manifest.object_ref !== reconcile.receipt.output_manifest.object_ref ||
      frozen.request.input_manifest.sha256 !== reconcile.receipt.output_manifest.sha256 ||
      frozen.receipt.attempt_ref !== frozen.attempt_ref || frozen.receipt.request_sha256 !== frozen.request_sha256) {
    fail("historical RECONCILE and FREEZE_EVIDENCE checkpoints are not contiguous");
  }
  const stageInputBytes = await readWorkflowObject(input.work_bucket, frozen.request.input_manifest, true);
  const stageInput = await decodeEvidenceFreezeStageInput(stageInputBytes);
  if (!sameRef(stageInput.freeze_ref, freezeRef)) {
    fail("historical freeze input does not name the exact artifact freeze");
  }
  const freezeBytes = await readWorkflowObject(input.work_bucket, frozen.receipt.output_manifest, true);
  let freeze: EvidenceFreeze;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(freezeBytes);
    freeze = EvidenceFreezeSchema.parse(JSON.parse(text));
    if (canonicalEvidenceJson(freeze) !== text) fail("historical freeze bytes are not canonical");
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("ARTIFACT_COW_FREEZE_LINEAGE_INVALID:")) throw cause;
    fail("historical EvidenceFreeze object is malformed");
  }
  if (!sameRef(freeze.freeze_ref, freezeRef) || !sameRef(freeze.scope_snapshot_ref, scopeRef) ||
      frozen.receipt.output_manifest.residency.scope_domain_id !== scopeRef.id) {
    fail("historical freeze output differs from the exact artifact freeze or scope");
  }
  return Object.freeze({ operation_id: row.operation_id, investigation_ref: frozen.request.investigation_ref,
    freeze, freeze_sha256: await digest(freezeBytes) });
}
