import type { ResearchWorkflowStage } from "@eliotr/contracts";
import { domainError, type DomainError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export const RESEARCH_WORKFLOW_STAGES: readonly ResearchWorkflowStage[] = [
  "FREEZE_PROTOCOL_AND_SCOPE", "ORIENT", "INTERPRET", "COMPILE_OBLIGATIONS", "PLAN",
  "RETRIEVE_BRANCHES", "ACQUIRE_AND_CAPTURE", "READ_AND_EXTRACT", "ANALYZE_BRANCHES",
  "COUNTER_SEARCH", "RECONCILE", "FREEZE_EVIDENCE", "SYNTHESIZE", "VERIFY",
  "AUDIT_CLAIMS", "RESOLVE_CITATIONS", "CALCULATE_COVERAGE", "MATERIALIZE",
] as const;

export function nextResearchStage(current: ResearchWorkflowStage): ResearchWorkflowStage | null {
  const index = RESEARCH_WORKFLOW_STAGES.indexOf(current);
  return index < 0 || index === RESEARCH_WORKFLOW_STAGES.length - 1 ? null : RESEARCH_WORKFLOW_STAGES[index + 1] ?? null;
}

export function validateResearchStageTransition(
  current: ResearchWorkflowStage,
  next: ResearchWorkflowStage,
  resumedFromCheckpoint: boolean,
): Result<ResearchWorkflowStage, DomainError> {
  if (current === next && resumedFromCheckpoint) return ok(next);
  return nextResearchStage(current) === next
    ? ok(next)
    : err(domainError("INVALID_TRANSITION", `${current} cannot transition directly to ${next}`));
}

export function assertEvidenceFreezeBeforeSynthesis(stage: ResearchWorkflowStage, freezePresent: boolean): Result<void, DomainError> {
  const synthesisIndex = RESEARCH_WORKFLOW_STAGES.indexOf("SYNTHESIZE");
  if (RESEARCH_WORKFLOW_STAGES.indexOf(stage) >= synthesisIndex && !freezePresent) {
    return err(domainError("POST_FREEZE_EVIDENCE", "synthesis and later stages require an evidence freeze"));
  }
  return ok(undefined);
}
