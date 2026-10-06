/** R2-specific transport over the provider-neutral OffsiteCopyAdapter contract. */
export { createS3OffsiteCopyAdapter, signSigV4S3Request, type S3OffsiteCopyAdapterConfig } from "./backup-offsite-s3.js";

/** Cloudflare D1/R2 isolated-target attestation; performs no restore writes. */
export * from "./isolated-restore-preflight.js";
export * from "./restore-admission.js";
export * from "./restore-store.js";
export * from "./restore-executor.js";
export * from "./restore-erasure-gate.js";
export { BackupR2ConfigurationError, readInstalledBackupR2Profile, requireInstalledBackupR2Authority, readInstalledBackupR2Credentials, createInstalledBackupOffsiteR2Resolver } from "./installed-offsite-configuration.js";
export type { BackupR2Environment, InstalledBackupR2Profile, InstalledBackupAdapterAuthority } from "./installed-offsite-configuration.js";
export * from "./primary-writer-qualification.js";
export * from "./primary-writer-runtime.js";
export * from "./primary-writer-inventory.js";
export * from "./backup-epoch-manifest-publisher.js";
