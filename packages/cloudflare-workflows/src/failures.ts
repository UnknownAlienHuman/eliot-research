import { z } from "zod";
import { ResearchWorkflowStageSchema } from "@eliotr/contracts";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { WorkflowCheckpointError, type WorkflowPrincipal } from "./types.js";

/** Closed transport vocabulary. Never serialize messages, stacks or nested causes. */
export const WORKFLOW_FAILURE_CODES = [
  "WORKFLOW_INPUT_INVALID",
  "WORKFLOW_CONFLICT",
  "WORKFLOW_AUTHORITY_STALE",
  "WORKFLOW_STAGE_OUT_OF_ORDER",
  "WORKFLOW_CANCELLED",
  "WORKFLOW_BUDGET_STOP",
  "WORKFLOW_EFFECT_UNCERTAIN",
  "WORKFLOW_OUTPUT_UNAVAILABLE",
  "WORKFLOW_OUTPUT_CORRUPT",
  "WORKFLOW_CONFIGURATION_MISSING",
  "WORKFLOW_CONFIGURATION_INVALID",
  "WORKFLOW_CREDENTIALS_MISSING",
  "WORKFLOW_CREDENTIALS_INVALID",
  "WORKFLOW_STORAGE_UNAVAILABLE",
  "WORKFLOW_QUALIFICATION_STALE",
  "WORKFLOW_PREPARATION_FAILED",
  "RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED",
  "RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE",
  "RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE",
  "RESEARCH_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE",
  "MODEL_ATTEMPT_INPUT_INVALID",
  "MODEL_ATTEMPT_AUTHORITY_STALE",
  "MODEL_ATTEMPT_IDENTITY_CONFLICT",
  "MODEL_ATTEMPT_BUDGET_EXPIRED",
  "MODEL_ATTEMPT_CONFLICT",
  "MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN",
  "MODEL_ATTEMPT_READBACK_CORRUPT",
  "MODEL_GATEWAY_DEPLOYMENT_MISSING",
  "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
  "MODEL_GATEWAY_REQUEST_INVALID",
  "MODEL_GATEWAY_CREDENTIAL_INVALID",
  "MODEL_GATEWAY_TRANSPORT_FAILED",
  "MODEL_GATEWAY_AUTH_REJECTED",
  "MODEL_GATEWAY_LIMIT_REJECTED",
  "MODEL_GATEWAY_POLICY_REJECTED",
  "MODEL_GATEWAY_UPSTREAM_REJECTED",
  "MODEL_GATEWAY_RESPONSE_INVALID",
  "MODEL_GATEWAY_OUTPUT_TRUNCATED",
  "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
  "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
  "MODEL_GATEWAY_PRICING_FAILED",
] as const;
export const WorkflowFailureSchema = z.object({
  code: z.enum(WORKFLOW_FAILURE_CODES),
  phase: z.enum(["PREPARATION", "STAGE", "RECOVERY"]),
  stage: ResearchWorkflowStageSchema.optional(),
  retryable: z.boolean(),
}).strict().refine((value) => value.phase === "PREPARATION" ? value.stage === undefined : value.stage !== undefined)
  .refine((value) => !value.retryable || (value.phase === "PREPARATION" && value.code === "WORKFLOW_STORAGE_UNAVAILABLE"));
export type WorkflowFailure = z.infer<typeof WorkflowFailureSchema>;

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
