import {
  createAiSearchErasureNamespace,
  createConfiguredErasureBackend,
  type AiSearchErasureNamespaceBinding,
} from "@eliotr/cloudflare-erasure";
import type { Env } from "./env.js";
import { createBackupPurgeReplayPort } from "@eliotr/platform-cloudflare";
import { createInstalledBackupOffsiteR2Resolver } from "./backup-offsite-composition.js";
import {
  createErasureCoordinator,
  type ErasureCoordinator,
} from "./erasure-coordinator.js";

export function createConfiguredErasureCoordinator(env: Env): ErasureCoordinator {
  const backend = createConfiguredErasureBackend({
    core_database: env.CORE_DB,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    work_bucket: env.WORK_BUCKET,
    managed_search: createAiSearchErasureNamespace(
      env.AI_SEARCH as unknown as AiSearchErasureNamespaceBinding,
    ),
    backup: createBackupPurgeReplayPort({
      core_db: env.CORE_DB,
      resolve_adapter: createInstalledBackupOffsiteR2Resolver(env),
    }),
    worker_id: `erasure:${env.DEPLOYMENT_GENERATION}`,
  });
  return createErasureCoordinator(backend);
}
