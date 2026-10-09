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
