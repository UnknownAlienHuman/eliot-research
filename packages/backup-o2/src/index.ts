// ER-34 O2 composition root. IMPLEMENTED_NOT_LIVE; O3/O4 NOT_IMPLEMENTED.
export * from "./shared.js";
export * from "./coverage.js";
export * from "./replay-authority.js";
export * from "./r2-inventory.js";
export * from "./epoch.js";
export * from "./destination-policy.js";
export * from "./offsite.js";
export * from "./expiry.js";

import type { BackupEpoch, OperationIntent, RestoreVerificationReceipt } from "@eliotr/contracts";
import { BackupError, resolveBackupExportLimits, type BackupExportLimits } from "./shared.js";
import { createBackupEpochPort, type BackupExportContext, type BackupSourcePorts, type BackupEpochResult } from "./epoch.js";
import { copyOffsiteExport, type OffsiteCopyInput, type OffsiteCopyResult } from "./offsite.js";

export interface BackupPort {
  createPortableEpoch(intent: OperationIntent, context?: BackupExportContext): Promise<BackupEpochResult>;
  copyOffsite(input: OffsiteCopyInput): Promise<OffsiteCopyResult>;
  markEpochForPurgeReplay(epochRef: string, purgeLedgerRevision: number): Promise<void>;
}

export interface RestorePort {
  restoreIsolated(epoch: BackupEpoch): Promise<string>;
  applyPurgeLedger(isolatedEnvironmentRef: string, revision: number): Promise<void>;
  rebuildProjections(isolatedEnvironmentRef: string): Promise<readonly string[]>;
  verifyBeforeTraffic(isolatedEnvironmentRef: string): Promise<RestoreVerificationReceipt>;
}

export function createBackupPort(ports: BackupSourcePorts, overrides?: { readonly limits?: Partial<BackupExportLimits> }): BackupPort {
  const epoch = createBackupEpochPort(ports, overrides);
  const limits = resolveBackupExportLimits(overrides?.limits);
  return {
    createPortableEpoch: (intent, context) => epoch.createPortableEpoch(intent, context),
    copyOffsite: (input) => copyOffsiteExport(ports, limits, input),
    markEpochForPurgeReplay: async () => {
      throw new BackupError("BACKUP_PURGE_REPLAY_NOT_IMPLEMENTED", "backup purge replay is not implemented (O4 erasure open); refusing silent completion", false, {});
    },
  };
}

export function createPendingRestorePort(): RestorePort {
  const pending = async (operation: string): Promise<never> => {
    throw new BackupError("BACKUP_RESTORE_NOT_IMPLEMENTED", `backup restore ${operation} is not implemented (O3 open); payload exposure refused`, false, {});
  };
  return {
    restoreIsolated: () => pending("restoreIsolated"),
    applyPurgeLedger: () => pending("applyPurgeLedger"),
    rebuildProjections: () => pending("rebuildProjections"),
    verifyBeforeTraffic: () => pending("verifyBeforeTraffic"),
  };
}
