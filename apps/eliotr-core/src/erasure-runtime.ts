import {
  createAiSearchErasureNamespace,
  type AiSearchErasureNamespaceBinding,
} from "@eliotr/cloudflare-erasure";
import { createBackupPurgeReplayPort } from "@eliotr/platform-cloudflare";
import {
  createConfiguredErasureCoordinator as createConfiguredErasureCoordinatorInLibrary,
  type ErasureCoordinator,
} from "@eliotr/cloudflare-erasure-operations";
import { createInstalledBackupOffsiteR2Resolver } from "@eliotr/cloudflare-backup";
import type { Env } from "./env.js";

export type { ErasureCoordinator };

/** Core adapts Worker bindings and the application-owned backup resolver to erasure operations. */
export function createConfiguredErasureCoordinator(env: Env & {
  readonly BACKUP_PARTS_BUCKET?: R2Bucket;
}): ErasureCoordinator {
  return createConfiguredErasureCoordinatorInLibrary({
    core_database: env.CORE_DB,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    work_bucket: env.WORK_BUCKET,
    ...(env.BACKUP_PARTS_BUCKET === undefined ? {} : { backup_parts_bucket: env.BACKUP_PARTS_BUCKET }),
    managed_search: createAiSearchErasureNamespace(
      env.AI_SEARCH as unknown as AiSearchErasureNamespaceBinding,
    ),
    backup: createBackupPurgeReplayPort({
      core_db: env.CORE_DB,
      resolve_adapter: createInstalledBackupOffsiteR2Resolver(env),
    }),
    worker_id: `erasure:${env.DEPLOYMENT_GENERATION}`,
  });
}
