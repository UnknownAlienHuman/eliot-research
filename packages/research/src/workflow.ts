import type { ResearchWorkflowStage, VersionedRef } from "@eliotr/contracts";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";

export interface WorkflowCheckpoint {
  readonly stage: ResearchWorkflowStage;
  readonly investigation_ref: VersionedRef;
  readonly input_manifest_ref: string;
  readonly output_manifest_ref: string;
  readonly idempotency_key: string;
  readonly budget_receipt_ref: string;
  readonly cancellation_checked_at: string;
}

export interface ResearchStageExecutor {
  execute(stage: ResearchWorkflowStage, input: WorkflowCheckpoint): Promise<WorkflowCheckpoint>;
}

export interface ResearchWorkflowPlan {
  readonly stages: readonly ResearchWorkflowStage[];
  readonly default_branch_fanout: 2;
  readonly maximum_branch_fanout: 4;
  readonly nested_fanout: 0;
  readonly workflow_step_returns_handles_only: true;
}

export function defaultResearchWorkflowPlan(): ResearchWorkflowPlan {
  return {
    stages: RESEARCH_WORKFLOW_STAGES,
    default_branch_fanout: 2,
    maximum_branch_fanout: 4,
    nested_fanout: 0,
    workflow_step_returns_handles_only: true,
  };
}

export const STAGE_INVARIANTS = {
  FREEZE_PROTOCOL_AND_SCOPE: ["protocol, lane, evaluator, scope, budget, and stop rule are revision-pinned"],
  FREEZE_EVIDENCE: ["all synthesis inputs and exclusions are immutable", "post-freeze evidence requires reopen"],
  SYNTHESIZE: ["reads only frozen evidence handles", "writes output to R2 before returning"],
  AUDIT_CLAIMS: ["reference, value, specification, method/artifact, source, and excerpt checks remain separate"],
  CALCULATE_COVERAGE: ["denominator kind cannot be inferred from workflow completion"],
  MATERIALIZE: ["large output is sectioned and returned by handle"],
} as const;

export const MAX_WORKFLOW_STEP_RESULT_BYTES = 64 * 1024;

const FORBIDDEN_STEP_KEYS = [
  "completion_disposition",
  "source_text",
  "model_output",
  "evidence_text",
  "excerpt",
] as const;

export function assertMonotoneStageSequence(stages: readonly ResearchWorkflowStage[]): void {
  if (stages.length !== RESEARCH_WORKFLOW_STAGES.length) {
    throw new Error(`WORKFLOW_STAGE_OUT_OF_ORDER: expected ${RESEARCH_WORKFLOW_STAGES.length} stages`);
  }
  for (let index = 0; index < RESEARCH_WORKFLOW_STAGES.length; index += 1) {
    if (stages[index] !== RESEARCH_WORKFLOW_STAGES[index]) {
      throw new Error(`WORKFLOW_STAGE_OUT_OF_ORDER: stage ${String(index)} must be ${String(RESEARCH_WORKFLOW_STAGES[index])}`);
    }
  }
}

export function assertHandleOnlyStepResultJson(jsonText: string): void {
  const bytes = new TextEncoder().encode(jsonText).byteLength;
  if (bytes > MAX_WORKFLOW_STEP_RESULT_BYTES) {
    throw new Error("WORKFLOW_INPUT_INVALID: step result exceeds 64KiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new Error("WORKFLOW_OUTPUT_CORRUPT: step result is not JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("WORKFLOW_OUTPUT_CORRUPT: step result must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of FORBIDDEN_STEP_KEYS) {
    if (key in record) {
      throw new Error(`WORKFLOW_INPUT_INVALID: step result must not contain ${key}`);
    }
  }
}
