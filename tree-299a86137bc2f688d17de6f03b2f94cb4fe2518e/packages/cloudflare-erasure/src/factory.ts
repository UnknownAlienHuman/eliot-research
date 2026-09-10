import type { ErasureBackend } from "@eliotr/contracts";
import { createD1ErasureAuthority } from "./authority.js";
import { createBackupErasureLocationPort } from "./backup-location.js";
import { createCloudflareErasureBackend } from "./backend.js";
import { createD1CoreErasureLocationPort } from "./core-location.js";
import { createD1ErasureInventory } from "./inventory.js";
import { createD1ErasureInvalidationPort } from "./invalidation.js";
import { createManagedSearchErasureLocationPort } from "./provider-location.js";
import { createR2ErasureLocationPort } from "./r2-location.js";
import { createErasureLocationRegistry } from "./registry.js";
import { createD1SearchErasureLocationPort } from "./search-location.js";
import type {
  BackupErasurePort,
  ManagedSearchErasureNamespace,
} from "./types.js";

export interface CloudflareErasureDependencies {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
  readonly managed_search?: ManagedSearchErasureNamespace;
  readonly backup?: BackupErasurePort;
  readonly worker_id?: string;
  readonly lease_ms?: number;
  readonly now?: () => number;
}

export function createConfiguredErasureBackend(
  dependencies: CloudflareErasureDependencies,
): ErasureBackend {
  const core = createD1CoreErasureLocationPort({
    database: dependencies.core_database,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  const r2 = createR2ErasureLocationPort({
    evidence_bucket: dependencies.evidence_bucket,
    work_bucket: dependencies.work_bucket,
  });
  const search = createD1SearchErasureLocationPort({
    database: dependencies.search_database,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  const provider = dependencies.managed_search === undefined
    ? undefined
    : createManagedSearchErasureLocationPort(dependencies.managed_search);
  const backup = dependencies.backup === undefined
    ? undefined
    : createBackupErasureLocationPort({
        database: dependencies.core_database,
        port: dependencies.backup,
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      });
  return createCloudflareErasureBackend({
    core_database: dependencies.core_database,
    authority: createD1ErasureAuthority({
      core_database: dependencies.core_database,
      ...(dependencies.worker_id === undefined ? {} : { worker_id: dependencies.worker_id }),
      ...(dependencies.lease_ms === undefined ? {} : { lease_ms: dependencies.lease_ms }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    }),
    inventory: createD1ErasureInventory({
      core_database: dependencies.core_database,
      search_database: dependencies.search_database,
    }),
    locations: createErasureLocationRegistry({
      CanonicalPayload: core,
      Projection: r2,
      Index: search,
      Blob: r2,
      OperationalRecovery: core,
      ...(provider === undefined ? {} : { ProviderCopy: provider }),
      ...(backup === undefined ? {} : { BackupRestorePath: backup }),
      RouteContinuation: core,
    }),
    invalidation: createD1ErasureInvalidationPort({
      database: dependencies.core_database,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}
