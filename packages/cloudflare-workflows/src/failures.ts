import { z } from "zod";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { WorkflowCheckpointError, type WorkflowPrincipal } from "./types.js";
import { WORKFLOW_FAILURE_CODES, WorkflowFailureSchema, type WorkflowFailure } from "./workflow-failure-protocol.js";
export { WORKFLOW_FAILURE_CODES, WorkflowFailureSchema } from "./workflow-failure-protocol.js";
export type { WorkflowFailure } from "./workflow-failure-protocol.js";

/** Only own data properties are examined; an Error's provider payload/cause is never traversed. */
export function workflowFailure(error: unknown, phase: WorkflowFailure["phase"],
  stage?: WorkflowFailure["stage"], safeReadRetry = false): WorkflowFailure {
  if (error instanceof WorkflowCheckpointError && error.failure !== undefined) {
    const existing = WorkflowFailureSchema.safeParse(error.failure);
    if (existing.success) return Object.freeze(existing.data);
  }
  const descriptor = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
  const value: unknown = descriptor?.value;
  const parsed = z.enum(WORKFLOW_FAILURE_CODES).safeParse(value);
  const code = parsed.success ? parsed.data : phase === "PREPARATION" ? "WORKFLOW_PREPARATION_FAILED" : "WORKFLOW_EFFECT_UNCERTAIN";
  return Object.freeze(WorkflowFailureSchema.parse({ code, phase,
    ...(phase === "PREPARATION" ? {} : { stage }),
    retryable: safeReadRetry && phase === "PREPARATION" && code === "WORKFLOW_STORAGE_UNAVAILABLE",
  }));
}

export function decodeWorkflowFailure(value: unknown): WorkflowFailure | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 1024) {
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  }
  try { return Object.freeze(WorkflowFailureSchema.parse(JSON.parse(value))); }
  catch { throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT"); }
}

/** Bounded diagnostic metadata on the existing run; it cannot authorize or advance execution. */
export async function recordWorkflowFailure(database: D1Database, operationId: string,
  principal: WorkflowPrincipal, value: WorkflowFailure): Promise<void> {
  const failure = WorkflowFailureSchema.parse(value);
  const text = JSON.stringify(failure);
  const stageIndex = failure.stage === undefined ? -1 : RESEARCH_WORKFLOW_STAGES.indexOf(failure.stage);
  const readback = () => database.prepare(
    "SELECT first_failure_json, latest_failure_json FROM research_workflow_run WHERE operation_id=?1 " +
    "AND principal_ref=?2 AND credential_generation=?3 AND deployment_generation=?4 LIMIT 1",
  ).bind(operationId, principal.principal_ref, principal.credential_generation, principal.deployment_generation)
    .first<{ first_failure_json: string | null; latest_failure_json: string | null }>();
  try {
    const writes = [];
    if (failure.stage !== undefined) writes.push(database.prepare(
      "UPDATE research_workflow_attempt SET first_failure_json=COALESCE(first_failure_json,?5) " +
      "WHERE operation_id=?1 AND stage_index=?6 AND EXISTS (SELECT 1 FROM research_workflow_run r " +
      "WHERE r.operation_id=?1 AND r.principal_ref=?2 AND r.credential_generation=?3 " +
      "AND r.deployment_generation=?4 AND r.state='ACTIVE' AND ?6<=r.next_stage_index)",
    ).bind(operationId, principal.principal_ref, principal.credential_generation, principal.deployment_generation,
      text, stageIndex));
    writes.push(database.prepare(
      "UPDATE research_workflow_run SET first_failure_json=COALESCE(first_failure_json,?5),latest_failure_json=?5 " +
      "WHERE operation_id=?1 AND principal_ref=?2 AND credential_generation=?3 AND deployment_generation=?4 " +
      "AND state='ACTIVE' AND (?6=-1 OR ?6<=next_stage_index)",
    ).bind(operationId, principal.principal_ref, principal.credential_generation, principal.deployment_generation,
      text, stageIndex));
    await database.batch(writes);
  } catch {
    // Lost write acknowledgement: inspect the same row, never replace the first cause.
  }
  const stored = await readback();
  if (stored === null || stored.first_failure_json === null || stored.latest_failure_json !== text) {
    throw new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE");
  }
  decodeWorkflowFailure(stored.first_failure_json);
  decodeWorkflowFailure(stored.latest_failure_json);
}

/** A diagnostics failure must not hide the error being diagnosed or claim durable retention. */
export async function retainWorkflowFailure(database: D1Database, operationId: string,
  principal: WorkflowPrincipal, failure: WorkflowFailure): Promise<void> {
  try { await recordWorkflowFailure(database, operationId, principal, failure); }
  catch {
    console.error(JSON.stringify({ event: "research_failure_retention_unavailable", code: failure.code,
      phase: failure.phase, ...(failure.stage === undefined ? {} : { stage: failure.stage }) }));
  }
}
