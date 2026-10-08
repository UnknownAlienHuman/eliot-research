import type { ErasureBackend } from "@eliotr/contracts";
import { erasureFail } from "./canonical.js";
import { createD1ErasureAuthority } from "./authority.js";
import { composeBackupErasurePort, createBackupErasureLocationPort } from "./backup-location.js";
import { createCloudflareErasureBackend } from "./backend.js";
import { createD1CoreErasureLocationPort } from "./core-location.js";
import { createD1ErasureInventory } from "./inventory.js";
import { createD1ErasureInvalidationPort } from "./invalidation.js";
import { createManagedSearchErasureLocationPort } from "./provider-location.js";
import { createR2ErasureLocationPort } from "./r2-location.js";
import { createErasureLocationRegistry } from "./registry.js";
import { createD1SearchErasureLocationPort } from "./search-location.js";
import { validateD1SearchEmptyProof } from "./empty-location-proof-authority.js";
import { validateR2WorkEmptyProof } from "./empty-location-proof-r2.js";
import type {
  BackupErasurePort,
  BackupPrimaryErasurePort,
  ManagedSearchErasureNamespace,
  BackupPrimaryWriterQualificationVerifier,
} from "./types.js";
import type {
  BackupEpochScopePort,
  BackupPrimaryInventoryPort,
} from "./backup-primary-contract.js";
import type { BackupProducerQuiescencePort } from "./backup-producer-quiescence-contract.js";

export interface CloudflareErasureDependencies {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
  readonly managed_search?: ManagedSearchErasureNamespace;
  /** Existing offsite erasure adapter; it is never sufficient without the primary bucket adapter. */
  readonly backup?: BackupErasurePort;
  readonly backup_primary?: BackupPrimaryErasurePort;
  readonly backup_primary_inventory?: BackupPrimaryInventoryPort;
  readonly backup_epoch_scope?: BackupEpochScopePort;
  readonly backup_producer_quiescence?: BackupProducerQuiescencePort;
  readonly backup_primary_qualification?: BackupPrimaryWriterQualificationVerifier;
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
  const backup = dependencies.backup === undefined || dependencies.backup_primary === undefined
    ? undefined
    : createBackupErasureLocationPort({
        database: dependencies.core_database,
        port: composeBackupErasurePort(dependencies.backup_primary, dependencies.backup),
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
      work_bucket: dependencies.work_bucket,
      ...(dependencies.backup === undefined ? {} : { backup_offsite: dependencies.backup }),
      ...(dependencies.backup_primary_qualification === undefined
        ? {} : { backup_primary_qualification: dependencies.backup_primary_qualification }),
      ...(dependencies.backup_primary_inventory === undefined
        ? {} : { backup_primary_inventory: dependencies.backup_primary_inventory }),
      ...(dependencies.backup_epoch_scope === undefined
        ? {} : { backup_epoch_scope: dependencies.backup_epoch_scope }),
      ...(dependencies.backup_producer_quiescence === undefined
        ? {} : { backup_producer_quiescence: dependencies.backup_producer_quiescence }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
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
    validateEmptyLocationProof: async (request, _fence, target) => {
      if (target.location === "Index") {
        await validateD1SearchEmptyProof(
          dependencies.core_database,
          dependencies.search_database,
          request,
          target,
        );
        return;
      }
      if (target.location === "Projection") {
        await validateR2WorkEmptyProof(
          dependencies.core_database,
          dependencies.work_bucket,
          request,
          target,
        );
        return;
      }
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "no authoritative empty-location verifier exists for this location");
    },
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}
