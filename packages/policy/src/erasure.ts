import type { ErasureReceipt, ErasureRequest, PurgeLocation } from "@eliotr/contracts";

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

export interface ErasureDependencyClosure {
  readonly request: ErasureRequest;
  readonly locations: ReadonlyMap<PurgeLocation, readonly string[]>;
  readonly dependent_wiki_block_refs: readonly string[];
  readonly dependent_artifact_section_refs: readonly string[];
  readonly backup_epoch_refs: readonly string[];
  readonly provider_copy_refs: readonly string[];
}

export interface ErasureBackend {
  quarantineAndRevoke(request: ErasureRequest): Promise<void>;
  enumerateClosure(request: ErasureRequest): Promise<ErasureDependencyClosure>;
  checkRetentionAndHolds(closure: ErasureDependencyClosure): Promise<readonly { location: PurgeLocation; blocking_ref: string; next_review_at: string }[]>;
  purge(location: PurgeLocation, objectRefs: readonly string[]): Promise<readonly string[]>;
  verifyAbsent(location: PurgeLocation, objectRefs: readonly string[]): Promise<boolean>;
  appendPurgeLedger(receipt: ErasureReceipt): Promise<string>;
  invalidateDependents(closure: ErasureDependencyClosure): Promise<void>;
}

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
