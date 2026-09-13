import { VersionedRefSchema } from "@eliotr/contracts";
import { canonicalEvidenceJson, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { canonicalDigest } from "@eliotr/platform-cloudflare";
import {
  fail,
  textDigest,
  WorkflowCheckpointError,
  type WorkflowAttemptRecoveryInput,
  type WorkflowPrincipal,
  type WorkflowStartedAttemptRecovery,
} from "@eliotr/cloudflare-workflows";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { readArtifactDraft, ArtifactDraftReadError } from "./artifact-draft-reader.js";
import { decodeResearchMaterializeResult } from "./research-materialize-result.js";
import { readCommittedResearchSynthesisOutput, ResearchSynthesisOutputError } from "./research-synthesis-output-reader.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/** Server-owned bindings needed to recover a MATERIALIZE result without running its handler. */
export interface ResearchMaterializeRecoveryDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly materialize_handler_generation: string;
}

interface DraftReservationRow {
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly artifact_id: unknown;
  readonly artifact_revision: unknown;
  readonly request_sha256: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly payload_ref: unknown;
  readonly state: unknown;
}

interface DraftManifestRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly manifest_sha256: unknown;
  readonly manifest_size_bytes: unknown;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("WORKFLOW_OUTPUT_CORRUPT");
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("WORKFLOW_OUTPUT_CORRUPT");
  return value;
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) fail("WORKFLOW_OUTPUT_CORRUPT");
  return value as number;
}

function mapReadFailure(error: unknown): never {
  if (error instanceof WorkflowCheckpointError) {
    if (error.code === "WORKFLOW_AUTHORITY_STALE" || error.code === "WORKFLOW_CANCELLED") fail("WORKFLOW_AUTHORITY_STALE");
    if (error.code === "WORKFLOW_OUTPUT_CORRUPT" || error.code === "WORKFLOW_INPUT_INVALID") fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  if (error instanceof ArtifactDraftReadError) {
    if (error.code === "ARTIFACT_DRAFT_READ_DENIED" || error.code === "ARTIFACT_DRAFT_READ_STALE") fail("WORKFLOW_AUTHORITY_STALE");
    if (error.code === "ARTIFACT_DRAFT_READ_INVALID" || error.code === "ARTIFACT_DRAFT_READ_INTEGRITY") fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  if (error instanceof ResearchSynthesisOutputError) {
    if (error.code === "SYNTHESIS_OUTPUT_AUTHORITY_STALE") fail("WORKFLOW_AUTHORITY_STALE");
    if (error.code === "SYNTHESIS_OUTPUT_CORRUPT") fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  fail("WORKFLOW_EFFECT_UNCERTAIN");
}

function snapshotPrincipal(input: WorkflowAttemptRecoveryInput, navigation: NavigationReadAuthority): WorkflowPrincipal {
  identifier(input.principal_ref, "principal_ref");
  identifier(input.credential_generation, "credential_generation");
  identifier(input.deployment_generation, "deployment_generation");
  if (input.principal_ref !== navigation.access.principal_ref || input.credential_generation !== navigation.access.credential_generation) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  return Object.freeze({
    principal_ref: input.principal_ref,
    credential_generation: input.credential_generation,
    deployment_generation: input.deployment_generation,
  });
}

async function readReservation(
  database: D1Database,
  input: WorkflowAttemptRecoveryInput,
  intentId: string,
  payloadRef: string,
): Promise<DraftReservationRow | null> {
  let row: DraftReservationRow | null;
  try {
    row = await database.prepare(
      "SELECT intent_id,intent_revision,artifact_id,artifact_revision,request_sha256,principal_ref,idempotency_key,payload_ref,state " +
      "FROM artifact_draft_reservation WHERE intent_id=?1 AND intent_revision=1 LIMIT 1",
    ).bind(intentId).first<DraftReservationRow>();
  } catch (error) {
    fail("WORKFLOW_EFFECT_UNCERTAIN");
  }
  if (row === null) return null;
  if (row.intent_id !== intentId || row.intent_revision !== 1 || row.state !== "FINALIZED" ||
      row.principal_ref !== input.principal_ref || row.idempotency_key !== input.request.idempotency_key || row.payload_ref !== payloadRef) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  identifier(row.artifact_id, "artifact_id");
  positiveRevision(row.artifact_revision);
  digest(row.request_sha256);
  return row;
}

async function readManifest(
  database: D1Database,
  artifactId: string,
  artifactRevision: number,
): Promise<DraftManifestRow | null> {
  let row: DraftManifestRow | null;
  try {
    row = await database.prepare(
      "SELECT artifact_id,revision,manifest_r2_key,manifest_sha256,manifest_size_bytes " +
      "FROM artifact_draft_binding WHERE artifact_id=?1 AND revision=?2 LIMIT 1",
    ).bind(artifactId, artifactRevision).first<DraftManifestRow>();
  } catch (error) {
    fail("WORKFLOW_EFFECT_UNCERTAIN");
  }
  if (row === null) return null;
  if (row.artifact_id !== artifactId || row.revision !== artifactRevision) fail("WORKFLOW_OUTPUT_CORRUPT");
  identifier(row.manifest_r2_key, "manifest_r2_key");
  digest(row.manifest_sha256);
  if (!Number.isSafeInteger(row.manifest_size_bytes) || (row.manifest_size_bytes as number) < 0) fail("WORKFLOW_OUTPUT_CORRUPT");
  return row;
}

function sameReservation(left: DraftReservationRow, right: DraftReservationRow): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

/**
 * Recovers only a previously written Stage17 draft. It never invokes a model,
 * materializer, or provider; a missing or changing readback remains uncertain.
 */
export function createResearchMaterializeRecovery(
  dependencies: ResearchMaterializeRecoveryDependencies,
): WorkflowStartedAttemptRecovery {
  const { database, work_bucket, navigation, materialize_handler_generation } = dependencies;
  return async (input) => {
    if (input.request.stage !== "MATERIALIZE" || input.request.handler_generation !== materialize_handler_generation) return null;
    const materializeIndex = RESEARCH_WORKFLOW_STAGES.indexOf("MATERIALIZE");
    if (materializeIndex < 0 || input.stage_index !== materializeIndex) {
      fail("WORKFLOW_INPUT_INVALID");
    }
    identifier(input.attempt_ref, "attempt_ref");
    digest(input.request_sha256);
    const actualRequestSha = await textDigest(JSON.stringify(input.request));
    if (actualRequestSha !== input.request_sha256) fail("WORKFLOW_OUTPUT_CORRUPT");
    const principal = snapshotPrincipal(input, navigation);

    let reportRequestSha: string;
    try { reportRequestSha = await canonicalDigest(input.request); }
    catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
    const intentId = `report-intent-${reportRequestSha}`;
    const payloadRef = `report-materialize-${reportRequestSha}`;
    const reservation = await readReservation(database, input, intentId, payloadRef);
    if (reservation === null) return null;
    const artifactRef = VersionedRefSchema.safeParse({ id: reservation.artifact_id, revision: reservation.artifact_revision });
    if (!artifactRef.success) fail("WORKFLOW_OUTPUT_CORRUPT");

    const recheckAuthority = async () => {
      await navigation.current();
      return Object.freeze({
        investigation_id: input.request.investigation_ref.id,
        scope_snapshot_id: navigation.scope.snapshot_id,
        scope_snapshot_revision: navigation.scope.revision,
      });
    };
    let synthesis: Awaited<ReturnType<typeof readCommittedResearchSynthesisOutput>>;
    try {
      synthesis = await readCommittedResearchSynthesisOutput({
        database,
        work_bucket,
        operation_id: input.request.operation_id,
        principal,
        recheck_authority: recheckAuthority,
      });
    } catch (error) { return mapReadFailure(error); }
    if (synthesis === null) return null;

    let artifact: Awaited<ReturnType<typeof readArtifactDraft>>;
    try {
      artifact = await readArtifactDraft({
        database,
        work_bucket,
        artifact_ref: Object.freeze({ ...artifactRef.data }),
        access: {
          principal_ref: principal.principal_ref,
          client_class: "owner_pwa",
          credential_generation: principal.credential_generation,
        },
        require_current: async (scope) => {
          await navigation.current(scope);
          return scope;
        },
      });
    } catch (error) { return mapReadFailure(error); }
    if (artifact === null || artifact.status !== "DRAFT" ||
        artifact.artifact_ref.id !== artifactRef.data.id || artifact.artifact_ref.revision !== artifactRef.data.revision) return null;

    const manifest = await readManifest(database, artifactRef.data.id, artifactRef.data.revision);
    if (manifest === null) return null;
    const finalReservation = await readReservation(database, input, intentId, payloadRef);
    if (finalReservation === null || !sameReservation(reservation, finalReservation)) fail("WORKFLOW_OUTPUT_CORRUPT");

    const materialization = decodeResearchMaterializeResult(new TextEncoder().encode(canonicalEvidenceJson({
      protocol: "eliotr.research.materialize-result.v1",
      operation_id: input.request.operation_id,
      stage: "MATERIALIZE",
      stage_attempt_ref: input.attempt_ref,
      stage_request_sha256: input.request_sha256,
      synthesis: {
        stage_attempt_ref: synthesis.stage_attempt_ref,
        stage_request_sha256: synthesis.stage_request_sha256,
        output_object_ref: synthesis.output.output_object_ref,
        output_sha256: synthesis.output.output_sha256,
      },
      draft: {
        artifact_ref: artifactRef.data,
        manifest: {
          key: manifest.manifest_r2_key,
          sha256: manifest.manifest_sha256,
          size_bytes: manifest.manifest_size_bytes,
        },
      },
    })));
    if (materialization.synthesis.stage_attempt_ref !== synthesis.stage_attempt_ref ||
        materialization.synthesis.stage_request_sha256 !== synthesis.stage_request_sha256 ||
        materialization.synthesis.output_object_ref !== synthesis.output.output_object_ref ||
        materialization.synthesis.output_sha256 !== synthesis.output.output_sha256) fail("WORKFLOW_OUTPUT_CORRUPT");
    const bytes = new TextEncoder().encode(canonicalEvidenceJson(materialization));
    await dependencies.navigation.current().catch(mapReadFailure);
    return bytes;
  };
}
