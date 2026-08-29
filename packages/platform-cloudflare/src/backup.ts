import type { BackupEpoch, RestoreVerificationReceipt } from "@eliotr/contracts";

export interface BackupPort {
  createPortableEpoch(): Promise<BackupEpoch>;
  copyOffsite(epoch: BackupEpoch): Promise<{ offsite_copy_ref: string; readback_digest: string }>;
  markEpochForPurgeReplay(epochRef: string, purgeLedgerRevision: number): Promise<void>;
}

export interface RestorePort {
  restoreIsolated(epoch: BackupEpoch): Promise<string>;
  applyPurgeLedger(isolatedEnvironmentRef: string, revision: number): Promise<void>;
  rebuildProjections(isolatedEnvironmentRef: string): Promise<readonly string[]>;
  verifyBeforeTraffic(isolatedEnvironmentRef: string): Promise<RestoreVerificationReceipt>;
}
