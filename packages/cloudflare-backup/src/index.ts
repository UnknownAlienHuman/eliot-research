/** R2-specific transport over the provider-neutral OffsiteCopyAdapter contract. */
export { createS3OffsiteCopyAdapter, signSigV4S3Request, type S3OffsiteCopyAdapterConfig } from "./backup-offsite-s3.js";

/** Cloudflare D1/R2 isolated-target attestation; performs no restore writes. */
export * from "./isolated-restore-preflight.js";
