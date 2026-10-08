import type { BackupEpochProducerClaim } from "@eliotr/backup-o2";

export const BACKUP_PRODUCER_QUIESCENCE_ACTIVE_STATES = [
  "REQUESTED", "QUARANTINE_AND_REVOKE", "ENUMERATE_DEPENDENCY_CLOSURE", "CHECK_RETENTION_AND_HOLDS",
  "PURGE_EACH_LOCATION", "VERIFY_ABSENCE_OR_BLOCK", "APPEND_PURGE_LEDGER", "INVALIDATE_DEPENDENTS",
] as const;

export type BackupProducerQuiescenceErasureState =
  typeof BACKUP_PRODUCER_QUIESCENCE_ACTIVE_STATES[number];

export interface BackupProducerQuiescenceContext {
  readonly erasure_id: string;
  readonly revision: number;
}

export interface BackupProducerQuiescenceSnapshot {
  readonly protocol: "eliotr.backup-producer-quiescence.v1";
  readonly erasure_id: string;
  readonly revision: number;
  readonly erasure_state: BackupProducerQuiescenceErasureState;
  readonly claim_count: number;
  readonly claims: readonly BackupEpochProducerClaim[];
  readonly claims_digest: string;
  /** Exact accepted-cut set, one-to-one with committed claims and receipts. */
  readonly accepted_cut_count: number;
  readonly accepted_cuts_digest: string;
  /** Digest of canonical backup_epoch rows linked one-to-one to COMMITTED claims. */
  readonly canonical_epoch_count: number;
  readonly canonical_epochs_digest: string;
}

export interface BackupProducerQuiescencePort {
  /**
   * The implementation binds producer claims, accepted cuts, and canonical
   * epochs, but does not prove worker-drain, full epoch qualification, or a
   * stable cross-table D1 snapshot; closure sealing must pin and re-read it.
   */
  assertQuiescent(
    context: BackupProducerQuiescenceContext,
  ): Promise<BackupProducerQuiescenceSnapshot>;
}
