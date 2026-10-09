import { z } from "zod";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  WorkflowFailureCompatibleSchema,
  WorkflowFailureHistorySchema,
  WorkflowFailureOutcomeSchema,
  WorkflowFailureSchema,
  WORKFLOW_FAILURE_CODES,
  type WorkflowFailure,
  type WorkflowFailureCompatible,
  type WorkflowFailureHistory,
  type WorkflowFailureOutcome,
} from "./workflow-failure-protocol.js";
import { WorkflowCheckpointError, type WorkflowPrincipal } from "./types.js";

export {
  WORKFLOW_FAILURE_CODES,
  WorkflowFailureCompatibleSchema,
  WorkflowFailureHistorySchema,
  WorkflowFailureOutcomeSchema,
  WorkflowFailureSchema,
} from "./workflow-failure-protocol.js";
export type {
  WorkflowFailure,
  WorkflowFailureCompatible,
  WorkflowFailureHistory,
  WorkflowFailureOutcome,
} from "./workflow-failure-protocol.js";

const MAX_FAILURE_HISTORY_BYTES = 24 * 1024;
const MAX_FAILURE_BYTES = 1024;
const UNCERTAIN_FAILURE_CODES = new Set<WorkflowFailure["code"]>([
  "WORKFLOW_EFFECT_UNCERTAIN",
  "MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN",
  "MODEL_GATEWAY_TRANSPORT_FAILED",
  "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
  "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED",
  "REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN",
  "EVIDENCE_SETTLEMENT_UNCERTAIN",
  "EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN",
]);

function ownValue(error: unknown, key: string): unknown {
  if (error === null || typeof error !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(error, key)?.value;
}

function outcomeFromLegacy(failure: WorkflowFailure): WorkflowFailureOutcome {
  return WorkflowFailureOutcomeSchema.parse({
    protocol: "eliotr.workflow-failure-outcome.v1",
    ...failure,
    dispatch_state: "OUTCOME_UNKNOWN",
    references_intact: "UNKNOWN",
    recovery_action: failure.retryable ? "READBACK" : "RECONCILE",
  });
}

function normalizeOutcome(value: WorkflowFailureCompatible): WorkflowFailureOutcome {
  const parsed = WorkflowFailureCompatibleSchema.parse(value);
  const outcome = WorkflowFailureOutcomeSchema.safeParse(parsed);
  return outcome.success ? outcome.data : outcomeFromLegacy(WorkflowFailureSchema.parse(parsed));
}

/** Project the V2 outcome back to the immutable V1 failure payload stored by legacy readers. */
export function workflowFailureCause(value: WorkflowFailureCompatible): WorkflowFailure {
  const failure = WorkflowFailureCompatibleSchema.parse(value);
  return WorkflowFailureSchema.parse({
    code: failure.code,
    phase: failure.phase,
    ...(failure.stage === undefined ? {} : { stage: failure.stage }),
    // V1 retryability meant a known safe storage read retry. Keep that old
    // meaning for persisted readers; V2 carries the independent domain hint.
    retryable: failure.retryable && failure.phase === "PREPARATION" &&
      failure.code === "WORKFLOW_STORAGE_UNAVAILABLE",
  });
}

export function workflowFailure(
  error: unknown,
  phase: WorkflowFailure["phase"],
  stage?: WorkflowFailure["stage"],
  safeReadRetry = false,
): WorkflowFailureOutcome {
  if (error instanceof WorkflowCheckpointError && error.failure !== undefined) {
    const existing = WorkflowFailureCompatibleSchema.safeParse(error.failure);
    if (existing.success) return Object.freeze(normalizeOutcome(existing.data));
  }
  const code = z.enum(WORKFLOW_FAILURE_CODES).safeParse(ownValue(error, "code"));
  const selectedCode = code.success
    ? code.data
    : phase === "PREPARATION" ? "WORKFLOW_PREPARATION_FAILED" : "WORKFLOW_EFFECT_UNCERTAIN";
  const hintedRetryable = ownValue(error, "retryable");
  const retryable = code.success && typeof hintedRetryable === "boolean"
    ? hintedRetryable
    : safeReadRetry && phase === "PREPARATION" && selectedCode === "WORKFLOW_STORAGE_UNAVAILABLE";
  const hintedDispatch = z.enum(["NOT_STARTED", "OUTCOME_UNKNOWN", "RESPONSE_RECEIVED"])
    .safeParse(ownValue(error, "dispatch_state"));
  const dispatchState = hintedDispatch.success
    ? hintedDispatch.data
    : phase !== "PREPARATION" || UNCERTAIN_FAILURE_CODES.has(selectedCode)
      ? "OUTCOME_UNKNOWN" : "NOT_STARTED";
  const hintedReferences = z.enum(["INTACT", "UNKNOWN"]).safeParse(ownValue(error, "references_intact"));
  const referencesIntact = dispatchState === "OUTCOME_UNKNOWN"
    ? "UNKNOWN"
    : hintedReferences.success ? hintedReferences.data : "UNKNOWN";
  const hintedRecovery = z.enum(["NONE", "READBACK", "RECONCILE"])
    .safeParse(ownValue(error, "recovery_action"));
  const recoveryAction = dispatchState === "OUTCOME_UNKNOWN"
    ? hintedRecovery.success && hintedRecovery.data !== "NONE" ? hintedRecovery.data : "RECONCILE"
    : hintedRecovery.success ? hintedRecovery.data : retryable ? "READBACK" : "NONE";
  return Object.freeze(WorkflowFailureOutcomeSchema.parse({
    protocol: "eliotr.workflow-failure-outcome.v1",
    code: selectedCode,
    phase,
    ...(phase === "PREPARATION" ? {} : { stage }),
    retryable,
    dispatch_state: dispatchState,
    references_intact: referencesIntact,
    recovery_action: recoveryAction,
  }));
}

export function decodeWorkflowFailure(value: unknown): WorkflowFailureCompatible | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_FAILURE_BYTES) {
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  }
  try { return Object.freeze(WorkflowFailureCompatibleSchema.parse(JSON.parse(value))); }
  catch { throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT"); }
}

function sameCause(left: WorkflowFailureCompatible, right: WorkflowFailureCompatible): boolean {
  return JSON.stringify(workflowFailureCause(left)) === JSON.stringify(workflowFailureCause(right));
}

function legacyHistory(
  first: WorkflowFailureCompatible | null,
  latest: WorkflowFailureCompatible | null,
): WorkflowFailureHistory {
  const firstCause = first === null ? null : normalizeOutcome(first);
  const latestOutcome = latest === null ? null : normalizeOutcome(latest);
  const consequences = firstCause !== null && latestOutcome !== null &&
      JSON.stringify(firstCause) !== JSON.stringify(latestOutcome)
    ? [latestOutcome]
    : [];
  return WorkflowFailureHistorySchema.parse({
    protocol: "eliotr.workflow-failure-history.v1",
    first_cause: firstCause,
    consequences,
  });
}

export function decodeWorkflowFailureHistory(
  value: unknown,
  first: WorkflowFailureCompatible | null,
  latest: WorkflowFailureCompatible | null,
): WorkflowFailureHistory {
  if (value === null || value === undefined) return legacyHistory(first, latest);
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_FAILURE_HISTORY_BYTES) {
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  }
  let history: WorkflowFailureHistory;
  try { history = WorkflowFailureHistorySchema.parse(JSON.parse(value)); }
  catch { throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT"); }
  if ((first === null) !== (history.first_cause === null) ||
      (first !== null && history.first_cause !== null && !sameCause(first, history.first_cause))) {
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  }
  const projectedLatest = history.consequences.at(-1) ?? history.first_cause;
  if ((latest === null) !== (projectedLatest === null) ||
      (latest !== null && projectedLatest !== null && !sameCause(latest, projectedLatest))) {
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  }
  return Object.freeze({
    ...history,
    ...(history.first_cause === null ? {} : { first_cause: Object.freeze(history.first_cause) }),
    consequences: Object.freeze(history.consequences.map((item) => Object.freeze(item))),
  });
}

/** Bounded diagnostic metadata on the existing run; it cannot authorize or advance execution. */
export async function recordWorkflowFailure(
  database: D1Database,
  operationId: string,
  principal: WorkflowPrincipal,
  value: WorkflowFailureCompatible,
): Promise<void> {
  const outcome = normalizeOutcome(value);
  const failure = workflowFailureCause(outcome);
  const text = JSON.stringify(failure);
  const outcomeText = JSON.stringify(outcome);
  const stageIndex = failure.stage === undefined ? -1 : RESEARCH_WORKFLOW_STAGES.indexOf(failure.stage);
  type FailureRow = {
      operation_id: string;
      principal_ref: string;
      credential_generation: string;
      deployment_generation: string;
      first_failure_json: string | null;
      latest_failure_json: string | null;
      failure_history_json: string | null;
    };
  const readback = async (): Promise<FailureRow | null> => {
    try {
      return await database.prepare(
        "SELECT operation_id, principal_ref, credential_generation, deployment_generation, " +
        "first_failure_json, latest_failure_json, failure_history_json FROM research_workflow_run " +
        "WHERE operation_id=?1 AND principal_ref=?2 AND credential_generation=?3 " +
        "AND deployment_generation=?4 LIMIT 1",
      ).bind(operationId, principal.principal_ref, principal.credential_generation, principal.deployment_generation)
        .first<FailureRow>();
    } catch {
      throw new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE");
    }
  };
  const hasOutcome = (history: WorkflowFailureHistory): boolean =>
    (history.first_cause !== null && JSON.stringify(history.first_cause) === outcomeText) ||
    history.consequences.some((item) => JSON.stringify(item) === outcomeText);

  // A bounded compare-and-swap handles concurrent diagnostics without ever
  // replacing first cause or retrying a provider effect. Exact readback also
  // reconciles a lost D1 acknowledgement under the same run identity.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readback();
    if (current === null || current.operation_id !== operationId || current.principal_ref !== principal.principal_ref ||
        current.credential_generation !== principal.credential_generation ||
        current.deployment_generation !== principal.deployment_generation) {
      throw new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE");
    }
    const first = decodeWorkflowFailure(current.first_failure_json);
    const latest = decodeWorkflowFailure(current.latest_failure_json);
    const history = decodeWorkflowFailureHistory(current.failure_history_json, first, latest);
    if (hasOutcome(history)) return;
    if (history.first_cause !== null && history.consequences.length >= 16) {
      throw new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE");
    }
    const nextHistory = WorkflowFailureHistorySchema.parse(history.first_cause === null
      ? { protocol: "eliotr.workflow-failure-history.v1", first_cause: outcome, consequences: [] }
      : { ...history, consequences: [...history.consequences, outcome] });
    const nextFirst = current.first_failure_json ?? JSON.stringify(workflowFailureCause(outcome));
    const latestOutcome = nextHistory.consequences.at(-1) ?? nextHistory.first_cause;
    if (latestOutcome === null) throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
    const nextLatest = JSON.stringify(workflowFailureCause(latestOutcome));
    try {
      await database.prepare(
        "UPDATE research_workflow_run SET first_failure_json=?5,latest_failure_json=?6,failure_history_json=?7 " +
        "WHERE operation_id=?1 AND principal_ref=?2 AND credential_generation=?3 AND deployment_generation=?4 " +
        "AND state='ACTIVE' AND (?8=-1 OR ?8<=next_stage_index) " +
        "AND first_failure_json IS ?9 AND latest_failure_json IS ?10 AND failure_history_json IS ?11",
      ).bind(operationId, principal.principal_ref, principal.credential_generation, principal.deployment_generation,
        nextFirst, nextLatest, JSON.stringify(nextHistory), stageIndex, current.first_failure_json,
        current.latest_failure_json, current.failure_history_json).run();
    } catch {
      // Readback below decides whether this exact outcome was durably retained.
    }
    const stored = await readback();
    if (stored === null || stored.operation_id !== operationId || stored.principal_ref !== principal.principal_ref ||
        stored.credential_generation !== principal.credential_generation ||
        stored.deployment_generation !== principal.deployment_generation) {
      throw new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE");
    }
    const storedFirst = decodeWorkflowFailure(stored.first_failure_json);
    const storedLatest = decodeWorkflowFailure(stored.latest_failure_json);
    const storedHistory = decodeWorkflowFailureHistory(stored.failure_history_json, storedFirst, storedLatest);
    if (hasOutcome(storedHistory)) {
      if (failure.stage !== undefined) {
        try {
          await database.prepare(
            "UPDATE research_workflow_attempt SET first_failure_json=COALESCE(first_failure_json,?5) " +
            "WHERE operation_id=?1 AND stage_index=?6 AND EXISTS (SELECT 1 FROM research_workflow_run r " +
            "WHERE r.operation_id=?1 AND r.principal_ref=?2 AND r.credential_generation=?3 " +
            "AND r.deployment_generation=?4 AND r.state='ACTIVE' AND ?6<=r.next_stage_index)",
          ).bind(operationId, principal.principal_ref, principal.credential_generation, principal.deployment_generation,
            text, stageIndex).run();
        } catch {
          // The canonical run history is durable; attempt metadata is secondary.
        }
      }
      return;
    }
  }
  throw new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE");
}

/** A diagnostics failure must not hide the error being diagnosed or claim durable retention. */
export async function retainWorkflowFailure(
  database: D1Database,
  operationId: string,
  principal: WorkflowPrincipal,
  failure: WorkflowFailureCompatible,
): Promise<void> {
  try { await recordWorkflowFailure(database, operationId, principal, failure); }
  catch {
    console.error(JSON.stringify({ event: "research_failure_retention_unavailable", code: failure.code,
      phase: failure.phase, ...(failure.stage === undefined ? {} : { stage: failure.stage }) }));
  }
}
