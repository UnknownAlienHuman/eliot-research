import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import type { ResearchWorkflowStage } from "@eliotr/contracts";

export const WORKFLOW_CHECKPOINT_PHASES = [
  "current_read",
  "prepare",
  "authority",
  "budget_check",
  "input_read",
  "handler",
  "output_recovery",
  "output_intent",
  "output_persist",
  "checkpoint_commit",
  "readback",
] as const;

export type WorkflowCheckpointPhase = typeof WORKFLOW_CHECKPOINT_PHASES[number];

export interface WorkflowCheckpointPerformanceIdentity {
  readonly operation_id: string;
  readonly stage: ResearchWorkflowStage;
}

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;

function validIdentity(identity: WorkflowCheckpointPerformanceIdentity): boolean {
  return OPERATION_ID.test(identity.operation_id) && RESEARCH_WORKFLOW_STAGES.includes(identity.stage);
}

/** Diagnostic measurement must never change the checkpoint operation's value or error. */
export async function measureWorkflowCheckpointPhase<T>(
  identity: WorkflowCheckpointPerformanceIdentity,
  phase: WorkflowCheckpointPhase,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let succeeded = false;
  try {
    const result = await action();
    succeeded = true;
    return result;
  } finally {
    try {
      if (validIdentity(identity) && (WORKFLOW_CHECKPOINT_PHASES as readonly string[]).includes(phase)) {
        const duration = Date.now() - startedAt;
        if (Number.isFinite(duration)) {
          console.warn(JSON.stringify({
            event: "workflow_checkpoint_phase",
            operation_id: identity.operation_id,
            stage: identity.stage,
            phase,
            duration_ms: Math.max(0, duration),
            succeeded,
          }));
        }
      }
    } catch {
      // Performance diagnostics are best-effort and cannot alter the outcome.
    }
  }
}
