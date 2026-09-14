const RESEARCH_DEFAULT_STAGE_LEASE_MS = 300_000;
export const RESEARCH_MODEL_STAGE_LEASE_MS = 600_000;

export function isResearchModelStage(stage: string): boolean {
  return stage === "SYNTHESIZE" || stage === "AUDIT_CLAIMS";
}

export function researchStageBudgetLeaseMs(stage: string): number {
  return isResearchModelStage(stage) ? RESEARCH_MODEL_STAGE_LEASE_MS : RESEARCH_DEFAULT_STAGE_LEASE_MS;
}
