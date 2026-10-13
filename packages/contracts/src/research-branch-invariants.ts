import type { ResearchDebt } from "./research.js";
import type { ResearchBranchRole } from "./research-branch-role.js";

/** Compare exact string members without a delimiter that may occur inside an identifier. */
export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sorted = [...right].sort();
  return left.length === sorted.length && [...left].sort().every((item, index) => item === sorted[index]);
}

/** Existing debtFor identity: exactly one OPEN debt names each blocked required role. */
export function branchDebtsMatchBlockedRoles(debts: readonly ResearchDebt[], roles: readonly ResearchBranchRole[]): boolean {
  return debts.length === roles.length && new Set(roles).size === roles.length &&
    debts.every((debt) => debt.status === "OPEN" && debt.blocked_refs.length === 1 &&
      roles.some((role) => role === debt.blocked_refs[0]) &&
      debts.filter((other) => other.blocked_refs[0] === debt.blocked_refs[0]).length === 1);
}

interface ReconciliationState {
  readonly required_roles: readonly ResearchBranchRole[];
  readonly branch_results: readonly { readonly role: ResearchBranchRole; readonly status: "CANDIDATE_READY" | "BLOCKED" }[];
  readonly unmet_required_roles: readonly ResearchBranchRole[];
  readonly research_debts: readonly Pick<ResearchDebt, "debt_ref" | "status">[];
  readonly counter_search_status: "NOT_REQUIRED" | "PARTIAL" | "COMPLETE";
}

/** Shared V1 semantics; codec identity and protocol checks stay with each version. */
export function reconciliationStateIssues(value: ReconciliationState): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  const required = new Set(value.required_roles);
  const roles = value.branch_results.map((item) => item.role);
  if (required.size !== value.required_roles.length || new Set(roles).size !== roles.length || roles.some((role) => !required.has(role))) {
    issues.push({ path: ["branch_results"], message: "branch reconciliation roles are inconsistent" });
  }
  const blocked = value.branch_results.filter((item) => item.status === "BLOCKED").map((item) => item.role).sort();
  const unmet = [...value.unmet_required_roles].sort();
  if (blocked.length !== unmet.length || blocked.some((role, index) => role !== unmet[index])) {
    issues.push({ path: ["unmet_required_roles"], message: "unmet roles are not derived from branch results" });
  }
  const debtRefs = value.research_debts.map((item) => `${item.debt_ref.id}:${item.debt_ref.revision}`);
  if (new Set(debtRefs).size !== debtRefs.length || value.research_debts.some((item) => item.status !== "OPEN")) {
    issues.push({ path: ["research_debts"], message: "branch debts are duplicated or not open" });
  }
  if (!required.has("COUNTER") && value.counter_search_status !== "NOT_REQUIRED") {
    issues.push({ path: ["counter_search_status"], message: "counter search ran for an unrequired role" });
  }
  if (required.has("COUNTER")) {
    const counter = value.branch_results.find((item) => item.role === "COUNTER");
    const expected = counter?.status === "CANDIDATE_READY" ? "COMPLETE" : "PARTIAL";
    if (counter === undefined || value.counter_search_status !== expected) {
      issues.push({ path: ["counter_search_status"], message: "counter search status does not match its branch result" });
    }
  }
  return issues;
}
