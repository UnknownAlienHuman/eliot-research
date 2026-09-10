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
  /** True once the canonical 70% warning threshold is reached. */
  readonly warning: boolean;
  readonly evidence_access_remains_available: true;
}

export function decideBudgetAction(state: BudgetPoolState): BudgetDecision {
  if (state.pool !== "platform" && state.pool !== "workers_ai" && state.pool !== "byok" && state.pool !== "total") {
    throw new RangeError("budget pool is invalid");
  }
  for (const [name, value] of Object.entries({
    limit_usd: state.limit_usd,
    committed_usd: state.committed_usd,
    reserved_usd: state.reserved_usd,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`budget ${name} must be finite and non-negative`);
  }
  const committed = state.committed_usd + state.reserved_usd;
  if (!Number.isFinite(committed)) throw new RangeError("budget committed amount overflowed");
  const utilization = state.limit_usd === 0 ? 1 : committed / state.limit_usd;
  if (!Number.isFinite(utilization)) throw new RangeError("budget utilization overflowed");
  const warning = utilization >= 0.70;
  const action: GovernorAction = utilization >= 1 ? "BLOCK_PREMIUM_CALLS"
    : utilization >= 0.95 ? "REQUIRE_EXPLICIT_CONFIRMATION"
      : utilization >= 0.90 ? "FORCE_ECONOMY_DEFAULT"
        : utilization >= 0.80 ? "STOP_OPTIONAL_DISTILLATION"
          : utilization >= 0.70 ? "REDUCE_SPECULATIVE_MAINTENANCE"
            : "ALLOW";
  return { utilization, action, warning, evidence_access_remains_available: true };
}
