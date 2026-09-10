// ER-34 O2 thin facade; substantive implementation lives in @eliotr/backup-o2.
export {
  createBackupPort, createPendingRestorePort, claimEpochReceipt, readCommittedEpochReceipt,
  createBackupEpochPort, copyOffsiteExport, createControlledOffsiteAdapter, expireOffsiteCopy,
} from "@eliotr/backup-o2";
export type {
  BackupEpochDraft, BackupEpochResult, BackupEpochPort, BackupExportContext, BackupSourcePorts,
  BackupPartRef, AuthorityVector, BackupExportLimits, BackupErrorCode, OffsiteCopyInput,
  OffsiteCopyResult, OffsiteCopyAdapter, OffsiteStoredPart, BackupDestinationPolicy,
  OffsiteDestinationDescriptor, ExpiryIntent, ExpiryReceipt, BackupPort, RestorePort,
} from "@eliotr/backup-o2";
export { BackupError } from "@eliotr/backup-o2";
