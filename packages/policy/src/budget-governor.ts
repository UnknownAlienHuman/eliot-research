export interface BudgetPoolState {
  readonly pool: "platform" | "workers_ai" | "byok" | "total";
  readonly limit_usd: number;
  readonly committed_usd: number;
  readonly reserved_usd: number;
}

export type GovernorAction =
  | "ALLOW"
  | "WARN"
  | "REDUCE_SPECULATIVE_MAINTENANCE"
  | "STOP_OPTIONAL_DISTILLATION"
  | "FORCE_ECONOMY_DEFAULT"
  | "REQUIRE_EXPLICIT_CONFIRMATION"
  | "BLOCK_PREMIUM_CALLS";

export interface BudgetDecision {
  readonly utilization: number;
  readonly action: GovernorAction;
  readonly evidence_access_remains_available: true;
}

export function decideBudgetAction(state: BudgetPoolState): BudgetDecision {
  const committed = state.committed_usd + state.reserved_usd;
  const utilization = state.limit_usd <= 0 ? 1 : committed / state.limit_usd;
  const action: GovernorAction = utilization >= 1 ? "BLOCK_PREMIUM_CALLS"
    : utilization >= 0.95 ? "REQUIRE_EXPLICIT_CONFIRMATION"
      : utilization >= 0.90 ? "FORCE_ECONOMY_DEFAULT"
        : utilization >= 0.80 ? "STOP_OPTIONAL_DISTILLATION"
          : utilization >= 0.70 ? "REDUCE_SPECULATIVE_MAINTENANCE"
            : utilization >= 0.60 ? "WARN"
              : "ALLOW";
  return { utilization, action, evidence_access_remains_available: true };
}
