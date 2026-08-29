import type { PolicyDecision, PolicyDecisionInput, ScopeSnapshot } from "@eliotr/contracts";

export const POLICY_ENFORCEMENT_ORDER = [
  "AUTHENTICATE_PRINCIPAL",
  "RESOLVE_SCOPE",
  "FREEZE_SCOPE_SNAPSHOT",
  "APPLY_PURGE_LEDGER",
  "SECURITY_READ_PERMISSION",
  "TASK_AND_SOURCE_POLICY",
  "CLIENT_DISCLOSURE",
  "INFERENCE_PROVIDER_DISCLOSURE",
  "RETRIEVAL",
  "POST_RETRIEVAL_RECHECK",
  "OUTPUT_MINIMIZATION",
] as const;
export type PolicyEnforcementStage = typeof POLICY_ENFORCEMENT_ORDER[number];

export interface PolicyStageReceipt {
  readonly stage: PolicyEnforcementStage;
  readonly decision: "ALLOW" | "ALLOW_WITH_MINIMIZATION" | "DENY";
  readonly reason_codes: readonly string[];
  readonly policy_generation: string;
  readonly input_digest: string;
  readonly output_digest: string;
}

export interface PolicyEvaluationResult {
  readonly input: PolicyDecisionInput;
  readonly scope_snapshot: ScopeSnapshot;
  readonly decision: PolicyDecision;
  readonly stage_receipts: readonly PolicyStageReceipt[];
}

export interface PolicyEngine {
  evaluate(input: PolicyDecisionInput): Promise<PolicyEvaluationResult>;
  recheckAfterRetrieval(
    prior: PolicyEvaluationResult,
    materializedSourceRevisionRefs: readonly string[],
  ): Promise<PolicyEvaluationResult>;
}

export function firstDeny(receipts: readonly PolicyStageReceipt[]): PolicyStageReceipt | null {
  return receipts.find((receipt) => receipt.decision === "DENY") ?? null;
}

export function enforcementOrderIsComplete(receipts: readonly PolicyStageReceipt[]): boolean {
  const observed = receipts.map((receipt) => receipt.stage);
  return observed.length === POLICY_ENFORCEMENT_ORDER.length
    && observed.every((stage, index) => stage === POLICY_ENFORCEMENT_ORDER[index]);
}
