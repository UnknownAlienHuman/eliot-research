import type { ErasureRequest, PurgeLocation } from "@eliotr/contracts";

export interface PurgeTarget {
  readonly location: PurgeLocation;
  readonly canonical_ref: string;
  readonly provider_ref?: string;
  readonly retention_or_hold_ref?: string;
}

export interface ErasureBackend {
  quarantineAndRevoke(request: ErasureRequest): Promise<void>;
  enumerateDependencyClosure(request: ErasureRequest): Promise<readonly PurgeTarget[]>;
  purge(target: PurgeTarget): Promise<"PURGED" | "NOT_FOUND" | "BLOCKED">;
  verifyAbsent(target: PurgeTarget): Promise<boolean>;
  appendNonRevealingLedgerEntry(request: ErasureRequest, completed: readonly PurgeTarget[]): Promise<string>;
  invalidateDependents(request: ErasureRequest): Promise<readonly string[]>;
}
