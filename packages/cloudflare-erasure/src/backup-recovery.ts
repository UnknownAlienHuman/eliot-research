import type { PurgeTarget } from "@eliotr/contracts";
import {
  verifyPortableBackupManifests,
  type BackupEpochDraft,
} from "@eliotr/backup-o2";
import { erasureDigest, erasureFail } from "./canonical.js";
import type {
  BackupEpochScopeInventory,
  BackupEpochScopePort,
  BackupEpochScopeSubject,
  BackupPrimaryInventoryPort,
  BackupPrimaryReplaySnapshot,
} from "./backup-primary-contract.js";
import { ensureClosureCapacity } from "./inventory-readers.js";

export interface BackupInventorySelection {
  readonly exact_subject_ref: string;
  readonly subject: BackupEpochScopeSubject;
}

export interface BackupTargetResolution {
  readonly inventory: BackupEpochScopeInventory;
  readonly targets: readonly PurgeTarget[];
}

export async function resolveBackupTargets(input: {
  readonly primary_inventory: BackupPrimaryInventoryPort;
  readonly epoch_scope: BackupEpochScopePort;
  readonly backup_replay: BackupPrimaryReplaySnapshot | null;
  readonly backup_selections: readonly BackupInventorySelection[];
  readonly current_target_count: number;
  readonly create_target: (
    subject: string,
    location: "BackupRestorePath",
    canonical_ref: string,
  ) => Promise<PurgeTarget>;
}): Promise<BackupTargetResolution> {
  const inventory = await input.primary_inventory.readEpochScopeInventory(
    input.backup_replay === null ? {} : { allowed_missing_keys: input.backup_replay.allowed_missing_keys },
  );
  const targets: PurgeTarget[] = [];
  if (input.backup_replay !== null) {
    const missingKeys = new Set(inventory.primary_parts.missing_keys);
    const allowedKeys = input.backup_replay.allowed_missing_keys;
    const pinnedParts = input.backup_replay.parts.map((pin) => ({
      key: pin.key,
      epoch_id: pin.epoch_id,
      manifest: pin.manifest,
      part_index: pin.part_index,
      part_sha256: pin.part_sha256,
      ...(pin.payload_identity_digest === undefined ? {} : { payload_identity_digest: pin.payload_identity_digest }),
      ...(pin.payload_part_count === undefined ? {} : { payload_part_count: pin.payload_part_count }),
      size_bytes: pin.size_bytes,
      etag: pin.etag,
      custom_metadata: pin.custom_metadata,
    }));
    const pinnedByKey = new Map(pinnedParts.map((pin) => [pin.key, pin]));
    const actualKeys = new Set(inventory.primary_parts.objects.map((pin) => pin.key));
    const expectedPresent = pinnedParts.filter((pin) => actualKeys.has(pin.key));
    const expectedMissing = pinnedParts.filter((pin) => !actualKeys.has(pin.key)).map((pin) => pin.key);
    if (inventory.primary_parts.objects.length !== expectedPresent.length ||
        await erasureDigest(inventory.primary_parts.objects) !== await erasureDigest(expectedPresent) ||
        missingKeys.size !== expectedMissing.length ||
        expectedMissing.some((key) => !missingKeys.has(key)) ||
        [...missingKeys].some((key) => !pinnedByKey.has(key) || !allowedKeys.has(key))) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "recovered primary prefix differs from the original sealed plan and exact durable delete intents");
    }
    for (const pin of inventory.primary_parts.objects) {
      const pinned = pinnedByKey.get(pin.key);
      if (pinned === undefined || await erasureDigest(pin) !== await erasureDigest(pinned)) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "recovered primary prefix contains bytes outside the original exact pins");
      }
    }
    const priorTargets = [...input.backup_replay.targets.values()]
      .sort((left, right) => left.target_id.localeCompare(right.target_id));
    if (priorTargets.length === 0) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "recovered backup closure has no exact persisted source targets");
    }
    ensureClosureCapacity(input.current_target_count, priorTargets.length, "recovered source-scoped backup erasure targets");
    targets.push(...priorTargets);
    return { inventory, targets };
  }

  const scopedEpochIds = await input.epoch_scope.scopeBackupEpochsForSubjects({
    subjects: input.backup_selections.map(({ subject }) => subject),
    archives: inventory.archives,
    copy_authority_epoch_ids: inventory.copy_authority_epoch_ids,
    verify_manifests: async ({ draft, plaintext_parts }) => {
      const verified = await verifyPortableBackupManifests({
        draft: draft as BackupEpochDraft,
        plaintext_parts,
      });
      return { source_rows: verified.source_rows };
    },
  });
  const subjectsByEpoch = new Map<string, string[]>();
  for (const [index, epochIds] of scopedEpochIds.entries()) {
    const exactSubjectRef = input.backup_selections[index]?.exact_subject_ref;
    if (exactSubjectRef === undefined) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup scope result lost its exact erasure subject");
    }
    for (const epochId of epochIds) {
      const refs = subjectsByEpoch.get(epochId) ?? [];
      refs.push(exactSubjectRef);
      subjectsByEpoch.set(epochId, refs);
    }
  }
  if (subjectsByEpoch.size === 0) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "no verified backup epoch contains the selected source roots");
  }
  for (const [epochId, subjectRefs] of [...subjectsByEpoch.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    ensureClosureCapacity(input.current_target_count + targets.length, 1, "source-scoped backup erasure targets");
    const representativeSubject = [...new Set(subjectRefs)].sort()[0];
    if (representativeSubject === undefined) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch target has no exact selected subject");
    }
    targets.push(await input.create_target(representativeSubject, "BackupRestorePath", `backup:${epochId}`));
  }
  return { inventory, targets };
}
