import type { ErasureFence } from "@eliotr/contracts";
import {
  readBackupPrimaryHandoff,
  type BackupPrimaryInventoryPort,
} from "@eliotr/cloudflare-erasure";
import { readD1BackupEpochScopeInventory } from "./backup-epoch-reader.js";
import { readBackupExportCutInventory, sealBackupPrimaryClosure } from "./backup-primary-closure.js";
import {
  allowedMissing,
  loadClosure,
  pinObject,
} from "./backup-primary-purge-plan.js";

export interface BackupPrimaryInventoryDependencies {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
}

export function createD1BackupPrimaryInventoryPort(
  dependencies: BackupPrimaryInventoryDependencies,
): BackupPrimaryInventoryPort {
  return {
    readEpochScopeInventory: (options = {}) => readD1BackupEpochScopeInventory(
      dependencies.database,
      dependencies.bucket,
      options,
    ),
    readExportCutInventory: () => readBackupExportCutInventory(dependencies.database),
    async loadReplay(input: { readonly fence: ErasureFence; readonly now_ms: number }) {
      const handoff = await readBackupPrimaryHandoff(dependencies.database, input.fence);
      if (handoff === null) return null;
      const closure = await loadClosure(
        dependencies.database,
        input.fence,
        input.now_ms,
        "QUARANTINE_AND_REVOKE",
      );
      return {
        header: {
          erasure_closure_digest: String(closure.header.erasure_closure_digest),
          producer_claims_digest: String(closure.header.producer_claims_digest),
          canonical_epoch_count: Number(closure.header.canonical_epoch_count),
          canonical_epochs_digest: String(closure.header.canonical_epochs_digest),
          export_cut_inventory_digest: String(closure.header.export_cut_inventory_digest),
        },
        targets: closure.targets,
        parts: closure.parts.map(pinObject),
        allowed_missing_keys: await allowedMissing(closure),
      };
    },
    sealClosure: async (input) => {
      await sealBackupPrimaryClosure({
        database: dependencies.database,
        ...input,
      });
    },
  };
}
