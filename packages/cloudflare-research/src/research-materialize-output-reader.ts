import { VersionedRefSchema, type ArtifactRevision, type VersionedRef } from "@eliotr/contracts";
import { readArtifactDraft, ArtifactDraftReadError } from "./artifact-draft-reader.js";
import { readCommittedResearchSynthesisOutput, ResearchSynthesisOutputError } from "./research-synthesis-output-reader.js";
import { readResearchRunStatus, type RunStatusAuthoritySnapshot } from "./research-run-status.js";
import { WorkflowCheckpointStore } from "./store.js";
import { readWorkflowObject } from "./objects.js";
import { WorkflowCheckpointError, type StageReceipt, type WorkflowPrincipal } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const MAX_RESULT_BYTES = 64 * 1024;

export type ResearchMaterializeOutputErrorCode =
  | "MATERIALIZE_OUTPUT_INPUT_INVALID"
  | "MATERIALIZE_OUTPUT_NOT_FOUND"
  | "MATERIALIZE_OUTPUT_AUTHORITY_STALE"
  | "MATERIALIZE_OUTPUT_CORRUPT"
  | "MATERIALIZE_OUTPUT_UNCERTAIN";

export class ResearchMaterializeOutputError extends Error {
  public readonly code: ResearchMaterializeOutputErrorCode;

  public constructor(code: ResearchMaterializeOutputErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchMaterializeOutputError";
    this.code = code;
  }
}

export interface ResearchMaterializeOutputReaderInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  /** Server-owned workflow identity; artifact and manifest refs are output-only. */
  readonly operation_id: string;
  readonly principal: WorkflowPrincipal;
  /** Server-configured generation that writes the materialization payload. */
  readonly materialize_handler_generation: string;
  /** Rechecks the owner-bound workflow scope before and after artifact disclosure. */
  readonly recheck_authority: () => Promise<RunStatusAuthoritySnapshot>;
}

export interface ResearchMaterializeOutput {
  readonly protocol: "eliotr.research.materialize-result.v1";
  readonly operation_id: string;
  readonly stage: "MATERIALIZE";
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly synthesis: {
    readonly stage_attempt_ref: string;
    readonly stage_request_sha256: string;
    readonly output_object_ref: string;
    readonly output_sha256: string;
  };
  readonly draft: {
    readonly artifact_ref: VersionedRef;
    readonly manifest: {
      readonly key: string;
      readonly sha256: string;
      readonly size_bytes: number;
    };
  };
}

export interface ResearchMaterializeOutputReadback {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly stage: "MATERIALIZE";
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly workflow_receipt: StageReceipt;
  readonly materialization: ResearchMaterializeOutput;
  readonly artifact: ArtifactRevision;
}

interface MaterializeManifestRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly manifest_sha256: unknown;
  readonly manifest_size_bytes: unknown;
}

function fail(code: ResearchMaterializeOutputErrorCode, message: string, cause?: unknown): never {
  throw new ResearchMaterializeOutputError(code, message, cause);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("MATERIALIZE_OUTPUT_CORRUPT", `${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("MATERIALIZE_OUTPUT_CORRUPT", `${label} is invalid`);
  return value;
}

function strictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("MATERIALIZE_OUTPUT_CORRUPT", `${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) fail("MATERIALIZE_OUTPUT_CORRUPT", `${label} contains an unsupported field`);
  if (keys.some((key) => !Object.hasOwn(record, key))) fail("MATERIALIZE_OUTPUT_CORRUPT", `${label} is incomplete`);
  return record;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function decodeResearchMaterializeOutput(bytes: Uint8Array): ResearchMaterializeOutput {
  if (bytes.byteLength > MAX_RESULT_BYTES) fail("MATERIALIZE_OUTPUT_CORRUPT", "materialization output is too large");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch (cause) { fail("MATERIALIZE_OUTPUT_CORRUPT", "materialization output is not strict UTF-8 JSON", cause); }
  const root = strictRecord(parsed, ["protocol", "operation_id", "stage", "stage_attempt_ref", "stage_request_sha256", "synthesis", "draft"], "materialization output");
  if (root.protocol !== "eliotr.research.materialize-result.v1" || root.stage !== "MATERIALIZE") fail("MATERIALIZE_OUTPUT_CORRUPT", "materialization output protocol is invalid");
  const synthesis = strictRecord(root.synthesis, ["stage_attempt_ref", "stage_request_sha256", "output_object_ref", "output_sha256"], "synthesis binding");
  const draft = strictRecord(root.draft, ["artifact_ref", "manifest"], "draft binding");
  const manifest = strictRecord(draft.manifest, ["key", "sha256", "size_bytes"], "draft manifest");
  let artifactRef: VersionedRef;
  try { artifactRef = VersionedRefSchema.parse(draft.artifact_ref); }
  catch (cause) { fail("MATERIALIZE_OUTPUT_CORRUPT", "draft artifact reference is invalid", cause); }
  if (!Number.isSafeInteger(manifest.size_bytes) || (manifest.size_bytes as number) < 0) fail("MATERIALIZE_OUTPUT_CORRUPT", "draft manifest size is invalid");
  return Object.freeze({
    protocol: "eliotr.research.materialize-result.v1",
    operation_id: text(root.operation_id, "materialization operation_id"),
    stage: "MATERIALIZE",
    stage_attempt_ref: text(root.stage_attempt_ref, "materialization stage attempt"),
    stage_request_sha256: sha(root.stage_request_sha256, "materialization stage request digest"),
    synthesis: Object.freeze({
      stage_attempt_ref: text(synthesis.stage_attempt_ref, "synthesis stage attempt"),
      stage_request_sha256: sha(synthesis.stage_request_sha256, "synthesis stage request digest"),
      output_object_ref: text(synthesis.output_object_ref, "synthesis output reference"),
      output_sha256: sha(synthesis.output_sha256, "synthesis output digest"),
    }),
    draft: Object.freeze({ artifact_ref: artifactRef, manifest: Object.freeze({
      key: text(manifest.key, "draft manifest key"),
      sha256: sha(manifest.sha256, "draft manifest digest"),
      size_bytes: manifest.size_bytes as number,
    }) }),
  });
}

function mapWorkflowFailure(error: unknown): never {
  if (error instanceof ResearchMaterializeOutputError) throw error;
  if (error instanceof WorkflowCheckpointError) {
    if (error.code === "WORKFLOW_AUTHORITY_STALE" || error.code === "WORKFLOW_CANCELLED") fail("MATERIALIZE_OUTPUT_AUTHORITY_STALE", "research workflow authority is no longer current", error);
    if (error.code === "WORKFLOW_OUTPUT_CORRUPT" || error.code === "WORKFLOW_INPUT_INVALID") fail("MATERIALIZE_OUTPUT_CORRUPT", "research workflow checkpoint is inconsistent", error);
  }
  fail("MATERIALIZE_OUTPUT_UNCERTAIN", "research workflow readback is unavailable", error);
}

function requireAuthority(snapshot: RunStatusAuthoritySnapshot, expected: { readonly investigation_id: string; readonly scope_snapshot_id: string; readonly scope_snapshot_revision: number }): void {
  if (snapshot.investigation_id !== expected.investigation_id || snapshot.scope_snapshot_id !== expected.scope_snapshot_id || snapshot.scope_snapshot_revision !== expected.scope_snapshot_revision) {
    fail("MATERIALIZE_OUTPUT_AUTHORITY_STALE", "research scope changed during artifact readback");
  }
}

function mapArtifactFailure(error: unknown): never {
  if (error instanceof ArtifactDraftReadError) {
    if (error.code === "ARTIFACT_DRAFT_READ_DENIED" || error.code === "ARTIFACT_DRAFT_READ_STALE") fail("MATERIALIZE_OUTPUT_AUTHORITY_STALE", "draft authority is no longer current", error);
    if (error.code === "ARTIFACT_DRAFT_READ_INTEGRITY") fail("MATERIALIZE_OUTPUT_CORRUPT", "draft readback integrity failed", error);
    if (error.code === "ARTIFACT_DRAFT_READ_INVALID") fail("MATERIALIZE_OUTPUT_INPUT_INVALID", "draft reference is invalid", error);
    fail("MATERIALIZE_OUTPUT_UNCERTAIN", "draft readback is unavailable", error);
  }
  fail("MATERIALIZE_OUTPUT_UNCERTAIN", "draft readback is unavailable", error);
}

function mapSynthesisFailure(error: unknown): never {
  if (error instanceof ResearchSynthesisOutputError) {
    if (error.code === "SYNTHESIS_OUTPUT_AUTHORITY_STALE") fail("MATERIALIZE_OUTPUT_AUTHORITY_STALE", "synthesis authority is no longer current", error);
    if (error.code === "SYNTHESIS_OUTPUT_CORRUPT") fail("MATERIALIZE_OUTPUT_CORRUPT", "synthesis readback is inconsistent", error);
    fail("MATERIALIZE_OUTPUT_UNCERTAIN", "synthesis readback is unavailable", error);
  }
  fail("MATERIALIZE_OUTPUT_UNCERTAIN", "synthesis readback is unavailable", error);
}

export async function readCommittedResearchMaterializeOutput(
  input: ResearchMaterializeOutputReaderInput,
): Promise<ResearchMaterializeOutputReadback | null> {
  if (typeof input.operation_id !== "string" || !IDENTIFIER.test(input.operation_id) || typeof input.materialize_handler_generation !== "string" || !IDENTIFIER.test(input.materialize_handler_generation)) {
    fail("MATERIALIZE_OUTPUT_INPUT_INVALID", "materialization reader input is invalid");
  }
  let status: Awaited<ReturnType<typeof readResearchRunStatus>>;
  try {
    status = await readResearchRunStatus({ database: input.database, operation_id: input.operation_id, principal: input.principal, recheck_authority: input.recheck_authority });
  } catch (error) { return mapWorkflowFailure(error); }
  if (status === null) return null;
  const expectedScope = { investigation_id: status.investigation_id, scope_snapshot_id: status.scope_snapshot_id, scope_snapshot_revision: status.scope_snapshot_revision };
  let generationRow: { readonly handler_generation: unknown } | null;
  try {
    generationRow = await input.database.prepare("SELECT handler_generation FROM research_workflow_run WHERE operation_id=?1 AND principal_ref=?2 LIMIT 1").bind(input.operation_id, input.principal.principal_ref).first<{ readonly handler_generation: unknown }>();
  } catch (error) { fail("MATERIALIZE_OUTPUT_UNCERTAIN", "materialization generation lookup failed", error); }
  if (generationRow === null || generationRow.handler_generation !== input.materialize_handler_generation) return null;
  const workflow = new WorkflowCheckpointStore(input.database);
  let committed;
  try { committed = await workflow.readCommittedStageRequest(input.operation_id, "MATERIALIZE"); }
  catch (error) { return mapWorkflowFailure(error); }
  if (committed === null) {
    if (status.state === "ENGINE_COMPLETED") fail("MATERIALIZE_OUTPUT_CORRUPT", "completed materialization stage is missing");
    return null;
  }
  let receipt: StageReceipt | null;
  try { receipt = await workflow.receipt(committed.request, committed.request_sha256); }
  catch (error) { return mapWorkflowFailure(error); }
  if (receipt === null || receipt.stage !== "MATERIALIZE" || receipt.engine_state !== "ENGINE_COMPLETED" || status.state !== "ENGINE_COMPLETED" || receipt.attempt_ref !== committed.attempt_ref || receipt.request_sha256 !== committed.request_sha256 || receipt.investigation_ref.id !== status.investigation_id) {
    fail("MATERIALIZE_OUTPUT_CORRUPT", "committed materialization receipt is missing or mismatched");
  }
  let before: RunStatusAuthoritySnapshot;
  try { before = await input.recheck_authority(); }
  catch (error) { return mapWorkflowFailure(error); }
  requireAuthority(before, expectedScope);
  let bytes: Uint8Array;
  try { bytes = await readWorkflowObject(input.work_bucket, receipt.output_manifest, true); }
  catch (error) { return mapWorkflowFailure(error); }
  const materialization = decodeResearchMaterializeOutput(bytes);
  if (materialization.operation_id !== input.operation_id || materialization.stage_attempt_ref !== committed.attempt_ref || materialization.stage_request_sha256 !== committed.request_sha256) {
    fail("MATERIALIZE_OUTPUT_CORRUPT", "materialization output is not bound to the committed stage");
  }
  let synthesis: Awaited<ReturnType<typeof readCommittedResearchSynthesisOutput>>;
  try {
    synthesis = await readCommittedResearchSynthesisOutput({ database: input.database, work_bucket: input.work_bucket, operation_id: input.operation_id, principal: input.principal, recheck_authority: input.recheck_authority });
  } catch (error) { return mapSynthesisFailure(error); }
  if (synthesis === null || synthesis.stage_attempt_ref !== materialization.synthesis.stage_attempt_ref || synthesis.stage_request_sha256 !== materialization.synthesis.stage_request_sha256 || synthesis.output.output_object_ref !== materialization.synthesis.output_object_ref || synthesis.output.output_sha256 !== materialization.synthesis.output_sha256) {
    fail("MATERIALIZE_OUTPUT_CORRUPT", "materialization synthesis binding differs from committed synthesis output");
  }
  const access = { principal_ref: input.principal.principal_ref, client_class: "owner_pwa" as const, credential_generation: input.principal.credential_generation };
  let artifact: ArtifactRevision | null;
  try {
    artifact = await readArtifactDraft({ database: input.database, work_bucket: input.work_bucket, artifact_ref: materialization.draft.artifact_ref, access, require_current: async (scope) => {
      const current = await input.recheck_authority();
      requireAuthority(current, { ...expectedScope, investigation_id: expectedScope.investigation_id });
      if (scope.snapshot_id !== expectedScope.scope_snapshot_id || scope.revision !== expectedScope.scope_snapshot_revision) fail("MATERIALIZE_OUTPUT_AUTHORITY_STALE", "draft scope differs from workflow scope");
      return scope;
    } });
  } catch (error) { return mapArtifactFailure(error); }
  if (artifact === null) fail("MATERIALIZE_OUTPUT_CORRUPT", "materialization points to a missing artifact");
  if (artifact.status !== "DRAFT" || !sameRef(artifact.artifact_ref, materialization.draft.artifact_ref)) fail("MATERIALIZE_OUTPUT_CORRUPT", "materialization points to a non-DRAFT or different artifact");
  let manifestRow: MaterializeManifestRow | null;
  try {
    manifestRow = await input.database.prepare("SELECT artifact_id, revision, manifest_r2_key, manifest_sha256, manifest_size_bytes FROM artifact_draft_binding WHERE artifact_id=?1 AND revision=?2 LIMIT 1").bind(materialization.draft.artifact_ref.id, materialization.draft.artifact_ref.revision).first<MaterializeManifestRow>();
  } catch (error) { fail("MATERIALIZE_OUTPUT_UNCERTAIN", "draft manifest binding lookup failed", error); }
  if (manifestRow === null || manifestRow.artifact_id !== materialization.draft.artifact_ref.id || manifestRow.revision !== materialization.draft.artifact_ref.revision || manifestRow.manifest_r2_key !== materialization.draft.manifest.key || manifestRow.manifest_sha256 !== materialization.draft.manifest.sha256 || manifestRow.manifest_size_bytes !== materialization.draft.manifest.size_bytes) fail("MATERIALIZE_OUTPUT_CORRUPT", "materialization draft manifest binding differs from durable storage");
  let after: RunStatusAuthoritySnapshot;
  try { after = await input.recheck_authority(); }
  catch (error) { return mapWorkflowFailure(error); }
  requireAuthority(after, expectedScope);
  return Object.freeze({ operation_id: input.operation_id, investigation_ref: receipt.investigation_ref, stage: "MATERIALIZE" as const, stage_attempt_ref: committed.attempt_ref, stage_request_sha256: committed.request_sha256, workflow_receipt: receipt, materialization, artifact });
}
