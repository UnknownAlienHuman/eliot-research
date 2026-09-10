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
