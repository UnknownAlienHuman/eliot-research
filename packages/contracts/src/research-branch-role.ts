import { z } from "zod";
import type { ResearchDebt } from "./research.js";

export const ResearchBranchRoleSchema = z.enum([
  "SUPPORT",
  "COUNTER",
  "ALTERNATIVE",
  "CHRONOLOGY",
  "IMPLEMENTATION",
  "LITERATURE",
  "SOURCE_AUDIT",
]);
export type ResearchBranchRole = z.infer<typeof ResearchBranchRoleSchema>;

/** Existing debtFor identity: exactly one OPEN debt names each blocked required role. */
export function branchDebtsMatchBlockedRoles(debts: readonly ResearchDebt[], roles: readonly ResearchBranchRole[]): boolean {
  return debts.length === roles.length && new Set(roles).size === roles.length &&
    debts.every((debt) => debt.status === "OPEN" && debt.blocked_refs.length === 1 &&
      roles.some((role) => role === debt.blocked_refs[0]) &&
      debts.filter((other) => other.blocked_refs[0] === debt.blocked_refs[0]).length === 1);
}
