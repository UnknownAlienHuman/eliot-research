import type {
  ErasureReceipt,
  ErasureRequest,
  PurgeLocation,
} from "@eliotr/contracts";

export type {
  AbsenceVerificationReceipt,
  ErasureBackend,
  ErasureBlocker,
  ErasureDependencyClosure,
  ErasureFence,
  ErasureReceipt,
  ErasureRequest,
  PurgeAttemptReceipt,
  PurgeLedgerEntry,
  PurgeLocation,
  PurgeTarget,
} from "@eliotr/contracts";

export const ERASURE_STAGES = [
  "REQUESTED",
  "QUARANTINE_AND_REVOKE",
  "ENUMERATE_DEPENDENCY_CLOSURE",
  "CHECK_RETENTION_AND_HOLDS",
  "PURGE_EACH_LOCATION",
  "VERIFY_ABSENCE_OR_BLOCK",
  "APPEND_PURGE_LEDGER",
  "INVALIDATE_DEPENDENTS",
  "COMPLETE_OR_BLOCKED",
] as const;

export interface ErasureCoordinator {
  execute(request: ErasureRequest): Promise<ErasureReceipt>;
}

export function exactLocationEquality(
  requested: readonly PurgeLocation[],
  completed: readonly PurgeLocation[],
): boolean {
  const left = [...new Set(requested)].sort();
  const right = [...new Set(completed)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
