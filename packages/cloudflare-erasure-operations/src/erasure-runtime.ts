import {
  createConfiguredErasureBackend,
  type BackupEpochScopePort,
  type BackupProducerQuiescencePort,
  type CloudflareErasureDependencies,
} from "@eliotr/cloudflare-erasure";
import type { ErasureReceipt, ErasureRequest } from "@eliotr/contracts";
import { createD1BackupProducerQuiescencePort } from "./backup-producer-quiescence.js";
import { createBackupEpochScopePort } from "./backup-epoch-scope.js";
import { createD1BackupPrimaryInventoryPort } from "./backup-primary-adapter.js";
import { createPrimaryBackupErasurePort } from "./backup-primary-purge.js";
import { createErasureCoordinator, type ErasureCoordinator } from "./erasure-coordinator.js";

export interface ErasureOperationsActor {
  readonly principal_ref: string;
  readonly credential_generation: string;
}

export interface ErasureDatabaseRuntime {
  readonly database: D1Database;
}

export interface ErasureOwnerServiceRuntime extends ErasureDatabaseRuntime {
  readonly coordinator: ErasureCoordinator;
}

export interface ErasureOwnerService {
  execute(actor: ErasureOperationsActor, request: ErasureRequest): Promise<ErasureReceipt>;
}

export type ErasureConfiguredCoordinatorDependencies = Omit<
  CloudflareErasureDependencies,
  "backup_parts_bucket"
> & {
  /** Primary O2 parts belong to the physical adapter owned by this package. */
  readonly backup_parts_bucket?: R2Bucket;
  readonly backup_producer_quiescence?: BackupProducerQuiescencePort;
  readonly backup_epoch_scope?: BackupEpochScopePort;
};

export function createConfiguredErasureCoordinator(
  dependencies: ErasureConfiguredCoordinatorDependencies,
): ErasureCoordinator {
  const backupProducerQuiescence = dependencies.backup_producer_quiescence ??
    createD1BackupProducerQuiescencePort(dependencies.core_database);
  const physical = dependencies.backup_parts_bucket === undefined
    ? {}
    : {
        backup_epoch_scope: dependencies.backup_epoch_scope ?? createBackupEpochScopePort(),
        backup_primary_inventory: dependencies.backup_primary_inventory ?? createD1BackupPrimaryInventoryPort({
          database: dependencies.core_database,
          bucket: dependencies.backup_parts_bucket,
        }),
        backup_primary: dependencies.backup_primary ?? createPrimaryBackupErasurePort({
          database: dependencies.core_database,
          bucket: dependencies.backup_parts_bucket,
          backup_producer_quiescence: backupProducerQuiescence,
          ...(dependencies.backup_primary_qualification === undefined
            ? {} : { qualification: dependencies.backup_primary_qualification }),
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        }),
      };
  const configuredDependencies = {
    ...dependencies,
    backup_producer_quiescence: backupProducerQuiescence,
    ...physical,
  };
  return createErasureCoordinator(createConfiguredErasureBackend(configuredDependencies));
}
