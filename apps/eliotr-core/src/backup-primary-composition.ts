import {
  assertCurrentPrimaryWriterRuntime,
  createPrimaryWriterQualificationVerifier,
  createQualifiedPrimaryBackupPort,
  readPrimaryWriterInventory as readPrimaryWriterInventoryFromBackup,
} from "@eliotr/cloudflare-backup";
import { createD1BackupProducerQuiescencePort } from "@eliotr/cloudflare-erasure-operations";
import { createR2EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";

type BackupPort = Awaited<ReturnType<typeof createQualifiedPrimaryBackupPort>>;
type PrimaryRuntimeEnv = Env & {
  readonly BACKUP_PARTS_BUCKET: R2Bucket;
  readonly VERSION_METADATA?: WorkerVersionMetadata;
};

function versionMetadata(env: PrimaryRuntimeEnv): WorkerVersionMetadata {
  if (env.VERSION_METADATA === undefined || typeof env.VERSION_METADATA.id !== "string" || env.VERSION_METADATA.id.length === 0) {
    throw new Error("VERSION_METADATA is required for primary-writer authority");
  }
  return env.VERSION_METADATA;
}

/** Owner-authenticated, read-only diagnostic. No request supplies identity metadata. */
export function readPrimaryWriterInventory(env: PrimaryRuntimeEnv): Promise<Record<string, unknown>> {
  const metadata = versionMetadata(env);
  return readPrimaryWriterInventoryFromBackup({
    CORE_DB: env.CORE_DB,
    BACKUP_PARTS_BUCKET: env.BACKUP_PARTS_BUCKET,
    DEPLOYMENT_GENERATION: env.DEPLOYMENT_GENERATION,
    VERSION_METADATA: metadata,
  });
}

/** Server-only composition; the Worker binding and version metadata are authoritative. */
export function createPrimaryBackupPort(env: PrimaryRuntimeEnv): Promise<BackupPort> {
  const metadata = versionMetadata(env);
  const part_sink = createR2EvidenceObjectStore(env.BACKUP_PARTS_BUCKET);
  return createQualifiedPrimaryBackupPort({
    database: env.CORE_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    work_bucket: env.WORK_BUCKET,
    part_sink,
    bucket: env.BACKUP_PARTS_BUCKET,
    binding_ref: "BACKUP_PARTS_BUCKET",
    controller_generation: env.DEPLOYMENT_GENERATION,
    version_id: metadata.id,
  });
}

export function createPrimaryWriterVerifier(env: PrimaryRuntimeEnv) {
  const metadata = versionMetadata(env);
  return createPrimaryWriterQualificationVerifier({
    database: env.CORE_DB,
    bucket: env.BACKUP_PARTS_BUCKET,
    binding_ref: "BACKUP_PARTS_BUCKET",
    controller_generation: env.DEPLOYMENT_GENERATION,
    version_id: metadata.id,
    producer_quiescence: createD1BackupProducerQuiescencePort(env.CORE_DB),
  });
}

export { assertCurrentPrimaryWriterRuntime };
