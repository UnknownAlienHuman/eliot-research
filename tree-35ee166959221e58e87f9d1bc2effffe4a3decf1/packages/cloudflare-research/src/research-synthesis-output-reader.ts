import type { VersionedRef } from "@eliotr/contracts";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  createModelAttemptStore,
} from "./model-attempt-store.js";
import type { ModelAttemptReadback, ModelOutputBinding } from "./model-attempt-types.js";
import { createResearchModelOutputStore } from "./research-model-output-store.js";
import { WorkflowCheckpointStore } from "./store.js";
import { readResearchRunStatus, type RunStatusAuthoritySnapshot } from "./research-run-status.js";
import { WorkflowCheckpointError, type StageReceipt, type WorkflowPrincipal } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;

export type ResearchSynthesisOutputErrorCode =
  | "SYNTHESIS_OUTPUT_INPUT_INVALID"
  | "SYNTHESIS_OUTPUT_NOT_FOUND"
  | "SYNTHESIS_OUTPUT_AUTHORITY_STALE"
  | "SYNTHESIS_OUTPUT_CORRUPT"
  | "SYNTHESIS_OUTPUT_UNCERTAIN";

export class ResearchSynthesisOutputError extends Error {
  public readonly code: ResearchSynthesisOutputErrorCode;

  public constructor(code: ResearchSynthesisOutputErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchSynthesisOutputError";
    this.code = code;
  }
}

export interface ResearchSynthesisOutputReaderInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  /** Server-owned workflow identity. Output refs are deliberately absent. */
  readonly operation_id: string;
  readonly principal: WorkflowPrincipal;
  /** Rechecks the owner-bound scope/currentness authority around R2 disclosure. */
  readonly recheck_authority: () => Promise<RunStatusAuthoritySnapshot>;
}

export interface ResearchSynthesisOutputReadback {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly stage: "SYNTHESIZE";
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly workflow_receipt: StageReceipt;
  readonly model_attempt: ModelAttemptReadback;
  readonly output: ModelOutputBinding;
  readonly bytes: Uint8Array;
}

interface StoredOutputRow {
  readonly attempt_id: unknown;
  readonly output_object_ref: unknown;
  readonly output_sha256: unknown;
  readonly principal_ref: unknown;
  readonly stage_attempt_ref: unknown;
  readonly stage_request_sha256: unknown;
  readonly state: unknown;
}

function fail(code: ResearchSynthesisOutputErrorCode, message: string, cause?: unknown): never {
  throw new ResearchSynthesisOutputError(code, message, cause);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("SYNTHESIS_OUTPUT_CORRUPT", `${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("SYNTHESIS_OUTPUT_CORRUPT", `${label} is invalid`);
  return value;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function mapWorkflowFailure(error: unknown): never {
  if (error instanceof ResearchSynthesisOutputError) throw error;
  if (error instanceof WorkflowCheckpointError) {
    if (error.code === "WORKFLOW_AUTHORITY_STALE" || error.code === "WORKFLOW_CANCELLED") {
      fail("SYNTHESIS_OUTPUT_AUTHORITY_STALE", "synthesis workflow authority is no longer current", error);
    }
    if (error.code === "WORKFLOW_OUTPUT_CORRUPT" || error.code === "WORKFLOW_INPUT_INVALID") {
      fail("SYNTHESIS_OUTPUT_CORRUPT", "synthesis workflow checkpoint is inconsistent", error);
    }
  }
  fail("SYNTHESIS_OUTPUT_UNCERTAIN", "synthesis workflow readback is unavailable", error);
}

function requireAuthority(
  snapshot: RunStatusAuthoritySnapshot,
  expected: { readonly investigation_id: string; readonly scope_snapshot_id: string; readonly scope_snapshot_revision: number },
): void {
  if (snapshot.investigation_id !== expected.investigation_id || snapshot.scope_snapshot_id !== expected.scope_snapshot_id ||
      snapshot.scope_snapshot_revision !== expected.scope_snapshot_revision) {
    fail("SYNTHESIS_OUTPUT_AUTHORITY_STALE", "synthesis scope changed during readback");
  }
}

function decodeOutputRow(row: StoredOutputRow, expected: { readonly attempt_ref: string; readonly request_sha256: string; readonly principal_ref: string }): {
  readonly attempt_id: string;
  readonly output: ModelOutputBinding;
} {
  const attemptId = text(row.attempt_id, "model attempt id");
  const outputRef = text(row.output_object_ref, "model output reference");
  const outputSha = sha(row.output_sha256, "model output digest");
  const principalRef = text(row.principal_ref, "model output principal");
  const stageAttemptRef = text(row.stage_attempt_ref, "model output stage attempt");
  const stageRequestSha = sha(row.stage_request_sha256, "model output stage request digest");
  if (row.state !== "COMMITTED" || principalRef !== expected.principal_ref || stageAttemptRef !== expected.attempt_ref ||
      stageRequestSha !== expected.request_sha256) {
    fail("SYNTHESIS_OUTPUT_CORRUPT", "committed synthesis output binding does not match the workflow stage");
  }
  return {
    attempt_id: attemptId,
    output: { output_object_ref: outputRef, output_sha256: outputSha, output_size_bytes: 0, readback_sha256: outputSha },
  };
}

function requireModelBinding(
  readback: ModelAttemptReadback,
  expected: {
    readonly attempt_id: string;
    readonly output: ModelOutputBinding;
    readonly principal: WorkflowPrincipal;
    readonly scope: VersionedRef;
    readonly stage_attempt_ref: string;
    readonly stage_request_sha256: string;
  },
): ModelOutputBinding {
  if (readback.attempt_id !== expected.attempt_id || readback.state !== "SUCCEEDED" ||
      readback.persisted_state !== "SUCCEEDED" || readback.receipt === null || readback.output === null ||
      readback.authority.principal_ref !== expected.principal.principal_ref ||
      readback.authority.credential_generation !== expected.principal.credential_generation ||
      readback.authority.deployment_generation !== expected.principal.deployment_generation ||
      !sameRef(readback.authority.scope_snapshot_ref, expected.scope) ||
      readback.stage_attempt_ref !== expected.stage_attempt_ref || readback.stage_request_sha256 !== expected.stage_request_sha256 ||
      readback.output.output_object_ref !== expected.output.output_object_ref ||
      readback.output.output_sha256 !== expected.output.output_sha256 ||
      readback.receipt.output_object_ref !== expected.output.output_object_ref ||
      readback.receipt.output_sha256 !== expected.output.output_sha256 ||
      readback.output.readback_sha256 !== expected.output.output_sha256) {
    fail("SYNTHESIS_OUTPUT_CORRUPT", "model attempt and synthesis output bindings differ");
  }
  return readback.output;
}

export async function readCommittedResearchSynthesisOutput(
  input: ResearchSynthesisOutputReaderInput,
): Promise<ResearchSynthesisOutputReadback | null> {
  if (typeof input.operation_id !== "string" || !IDENTIFIER.test(input.operation_id)) {
    fail("SYNTHESIS_OUTPUT_INPUT_INVALID", "operation_id is invalid");
  }
  let status: Awaited<ReturnType<typeof readResearchRunStatus>>;
  try {
    status = await readResearchRunStatus({
      database: input.database,
      operation_id: input.operation_id,
      principal: input.principal,
      recheck_authority: input.recheck_authority,
    });
  } catch (error) {
    return mapWorkflowFailure(error);
  }
  if (status === null) return null;
  const expectedScope = {
    investigation_id: status.investigation_id,
    scope_snapshot_id: status.scope_snapshot_id,
    scope_snapshot_revision: status.scope_snapshot_revision,
  };
  const workflow = new WorkflowCheckpointStore(input.database);
  let committed;
  try { committed = await workflow.readCommittedStageRequest(input.operation_id, "SYNTHESIZE"); }
  catch (error) { return mapWorkflowFailure(error); }
  if (committed === null) return null;
  if (committed.request.investigation_ref.id !== status.investigation_id ||
      committed.request.input_manifest.residency.scope_domain_id !== status.scope_snapshot_id ||
      committed.request.input_manifest.residency.access_domain_id !== input.principal.principal_ref) {
    fail("SYNTHESIS_OUTPUT_AUTHORITY_STALE", "synthesis stage is bound to a different owner scope");
  }
  let workflowReceipt: StageReceipt | null;
  try { workflowReceipt = await workflow.receipt(committed.request, committed.request_sha256); }
  catch (error) { return mapWorkflowFailure(error); }
  if (workflowReceipt === null || workflowReceipt.stage !== "SYNTHESIZE" || workflowReceipt.attempt_ref !== committed.attempt_ref ||
      workflowReceipt.request_sha256 !== committed.request_sha256 || workflowReceipt.investigation_ref.id !== status.investigation_id) {
    fail("SYNTHESIS_OUTPUT_CORRUPT", "committed synthesis workflow receipt is missing or mismatched");
  }
  let before: RunStatusAuthoritySnapshot;
  try { before = await input.recheck_authority(); }
  catch (error) { return mapWorkflowFailure(error); }
  requireAuthority(before, expectedScope);
  let rows: readonly StoredOutputRow[];
  try {
    const synthesisIndex = RESEARCH_WORKFLOW_STAGES.indexOf("SYNTHESIZE");
    if (synthesisIndex < 0) fail("SYNTHESIS_OUTPUT_CORRUPT", "synthesis stage is not registered");
    const result = await input.database.prepare(
      "SELECT o.attempt_id, o.output_object_ref, o.output_sha256, o.principal_ref, o.stage_attempt_ref, o.stage_request_sha256, o.state " +
      "FROM research_model_output o JOIN research_workflow_attempt w ON w.attempt_ref=o.stage_attempt_ref AND w.request_sha256=o.stage_request_sha256 " +
      "JOIN research_workflow_run r ON r.operation_id=w.operation_id " +
      "WHERE r.operation_id=?1 AND w.stage_index=?2 AND w.state='COMMITTED' AND o.state='COMMITTED' " +
      "AND o.stage_attempt_ref=?3 AND o.stage_request_sha256=?4 LIMIT 2",
    ).bind(input.operation_id, synthesisIndex, committed.attempt_ref, committed.request_sha256).all<StoredOutputRow>();
    rows = result.results;
  } catch (error) {
    fail("SYNTHESIS_OUTPUT_UNCERTAIN", "synthesis output binding lookup failed", error);
  }
  if (rows.length === 0) return null;
  if (rows.length !== 1) fail("SYNTHESIS_OUTPUT_CORRUPT", "multiple committed synthesis output bindings exist");
  const row = rows[0];
  if (row === undefined) fail("SYNTHESIS_OUTPUT_CORRUPT", "committed synthesis output row is missing");
  const decoded = decodeOutputRow(row, {
    attempt_ref: committed.attempt_ref,
    request_sha256: committed.request_sha256,
    principal_ref: input.principal.principal_ref,
  });
  const attemptStore = createModelAttemptStore(input.database);
  let modelReadback: ModelAttemptReadback | null;
  try { modelReadback = await attemptStore.readByAttempt(decoded.attempt_id); }
  catch (error) { fail("SYNTHESIS_OUTPUT_UNCERTAIN", "model attempt readback failed", error); }
  if (modelReadback === null) fail("SYNTHESIS_OUTPUT_CORRUPT", "model attempt binding is missing");
  const output = requireModelBinding(modelReadback, {
    attempt_id: decoded.attempt_id, output: decoded.output, principal: input.principal,
    scope: { id: status.scope_snapshot_id, revision: status.scope_snapshot_revision },
    stage_attempt_ref: committed.attempt_ref, stage_request_sha256: committed.request_sha256,
  });
  const outputStorage = createResearchModelOutputStore({ database: input.database, work_bucket: input.work_bucket });
  let bytes: Uint8Array;
  try { bytes = await outputStorage.readOutput({ output_object_ref: output.output_object_ref, output_sha256: output.output_sha256 }); }
  catch (error) { fail("SYNTHESIS_OUTPUT_UNCERTAIN", "committed synthesis output readback failed", error); }
  let after: RunStatusAuthoritySnapshot;
  try { after = await input.recheck_authority(); }
  catch (error) { return mapWorkflowFailure(error); }
  requireAuthority(after, expectedScope);
  return Object.freeze({
    operation_id: input.operation_id,
    investigation_ref: { id: status.investigation_id, revision: workflowReceipt.investigation_ref.revision },
    stage: "SYNTHESIZE" as const,
    stage_attempt_ref: committed.attempt_ref,
    stage_request_sha256: committed.request_sha256,
    workflow_receipt: workflowReceipt,
    model_attempt: modelReadback,
    output,
    bytes: new Uint8Array(bytes),
  });
}
