import type {
  ErasureFence,
  PurgeLocation,
  ErasureDependencyClosure,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  assertErasureSha256,
  assertErasureText,
  canonicalErasureJson,
  erasureDigest,
  erasureFail,
  parseErasureSubject,
  stableErasureId,
  validateErasureRequest,
} from "./canonical.js";
import type {
  ErasureInventoryPort,
  SourceRevisionInventoryRow,
  BackupErasurePort,
  BackupPrimaryWriterQualificationReceipt,
  BackupPrimaryWriterQualificationVerifier,
} from "./types.js";
import {
  backupPrimaryQualificationInput,
  type BackupEpochScopeInventory,
  type BackupEpochScopePort,
  type BackupExportCutInventory,
  type BackupPrimaryInventoryPort,
  type BackupPrimaryReplaySnapshot,
} from "./backup-primary-contract.js";
import type {
  BackupProducerQuiescencePort,
  BackupProducerQuiescenceSnapshot,
} from "./backup-producer-quiescence-contract.js";
import { sealBackupPrimaryHandoff } from "./backup-primary-handoff.js";
import { resolveBackupTargets, type BackupInventorySelection } from "./backup-recovery.js";
import { enumerateRawIngestDependencies } from "./raw-ingest-inventory.js";
import { createEmptyLocationProofTarget } from "./empty-location-proof.js";
import { makeD1SearchEmptyProofFields, readEmptyProofAuthorityDigest } from "./empty-location-proof-authority.js";
import { makeR2WorkEmptyProofTarget, readR2WorkEmptySnapshot } from "./empty-location-proof-r2.js";
import { verifyEvidenceHandleRoot, verifyScopeSnapshotRoots } from "./inventory-root-validation.js";
import {
  applyPending,
  earlierPending,
  evidenceR2Key,
  mergeTarget,
  refreshR2SharedReferenceCount,
  type RawPendingTargetOptions,
} from "./erasure-targets.js";
import {
  ensureClosureCapacity,
  oneRevision,
  projections,
  registered,
  registeredSharedCount,
  revisionRows,
  sourceOwnerGeneration,
} from "./inventory-readers.js";

interface ManagedProviderEffectRow {
  readonly source_revision_ref: unknown;
  readonly projection_generation: unknown;
  readonly managed_instance_id: unknown;
  readonly managed_generation: unknown;
  readonly item_key: unknown;
  readonly provider_key: unknown;
  readonly state: unknown;
  readonly provider_item_id: unknown;
  readonly readback_receipt_json: unknown;
  readonly readback_sha256: unknown;
}

interface ManagedProviderEffectInventory {
  readonly targets: readonly {
    readonly instance_id: string;
    readonly generation: string;
    readonly key: string;
    readonly projection_generation: string;
  }[];
  readonly project_copy_generations: ReadonlySet<string>;
}

function hasSortedKeyPrefix(keys: readonly string[], prefix: string): boolean {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = keys[middle];
    if (candidate === undefined) return false;
    if (candidate < prefix) low = middle + 1;
    else high = middle;
  }
  return keys[low]?.startsWith(prefix) === true;
}

/** Exact durable item intent/readback keys; never widen to a target or folder prefix. */
async function managedProviderEffects(
  database: D1Database,
  sourceRevisionRef: string,
): Promise<ManagedProviderEffectInventory> {
  let result: D1Result<ManagedProviderEffectRow>;
  try {
    result = await database.prepare(
      "SELECT source_revision_ref,projection_generation,managed_instance_id,managed_generation,item_key,provider_key," +
      "state,provider_item_id,readback_receipt_json,readback_sha256 " +
      "FROM projection_managed_item_effect WHERE source_revision_ref=?1 " +
      "ORDER BY managed_instance_id,managed_generation,provider_key LIMIT 10001",
    ).bind(sourceRevisionRef).all<ManagedProviderEffectRow>();
  } catch (cause) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "exact managed provider-copy inventory is unavailable", false, cause);
  }
  if (!result.success || !Array.isArray(result.results)) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "exact managed provider-copy inventory did not complete", true);
  }
  if (result.results.length > 10_000) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "exact managed provider-copy inventory exceeds its 10000-row bound");
  }
  const targets: ManagedProviderEffectInventory["targets"][number][] = [];
  const projectCopyGenerations = new Set<string>();
  const seen = new Set<string>();
  for (const row of result.results) {
    const source = assertErasureIdentifier(row.source_revision_ref, "provider effect source revision");
    if (source !== sourceRevisionRef) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "provider effect escaped the selected source revision");
    }
    const projectionGeneration = assertErasureIdentifier(row.projection_generation, "provider effect projection generation");
    const instanceId = assertErasureIdentifier(row.managed_instance_id, "provider effect instance");
    const generation = assertErasureIdentifier(row.managed_generation, "provider effect generation");
    const itemKey = assertErasureIdentifier(row.item_key, "provider effect item key");
    const key = assertErasureText(row.provider_key, "exact provider key", 1024);
    if (key.includes("//") || key.includes("\\") || /(^|\/)\.\.?($|\/)/u.test(key)) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "provider effect key is not an exact canonical item key");
    }
    if (row.state !== "READBACK_VERIFIED") {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "managed provider effect lacks exact completed provider readback");
    }
    const providerItemId = assertErasureIdentifier(row.provider_item_id, "provider effect item ID");
    const readbackSha256 = assertErasureSha256(row.readback_sha256, "provider effect readback digest");
    if (typeof row.readback_receipt_json !== "string") {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "managed provider effect lacks its exact readback receipt");
    }
    let readback: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.readback_receipt_json);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "managed provider readback receipt is not an object");
      }
      readback = parsed as Record<string, unknown>;
    } catch (cause) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "managed provider readback receipt is malformed", false, cause);
    }
    const readbackFields = [
      "chunks_count", "content_sha256", "file_size", "item_key", "provider_item_id",
      "provider_key", "readback_sha256",
    ];
    if (Object.keys(readback).sort().join("\n") !== readbackFields.sort().join("\n") ||
        canonicalErasureJson(readback) !== row.readback_receipt_json ||
        readback.item_key !== itemKey || readback.provider_key !== key ||
        readback.provider_item_id !== providerItemId || readback.readback_sha256 !== readbackSha256 ||
        !Number.isSafeInteger(readback.file_size) || (readback.file_size as number) < 1 ||
        !Number.isSafeInteger(readback.chunks_count) || (readback.chunks_count as number) < 1) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "managed provider effect and exact readback receipt differ");
    }
    assertErasureSha256(readback.content_sha256, "provider readback content digest");
    const identity = `${instanceId}\u0000${generation}\u0000${key}`;
    if (seen.has(identity)) erasureFail("ERASURE_IDENTITY_CONFLICT", "managed provider key/generation is ambiguous for this source");
    seen.add(identity);
    projectCopyGenerations.add(projectionGeneration);
    targets.push(Object.freeze({
      instance_id: instanceId,
      generation,
      key,
      projection_generation: projectionGeneration,
    }));
  }
  return Object.freeze({ targets: Object.freeze(targets), project_copy_generations: projectCopyGenerations });
}

async function target(
  exactSubjectRef: string,
  location: PurgeLocation,
  canonicalRef: string,
  options: {
    readonly provider_ref?: string;
    readonly shared_live_reference_count?: number;
    readonly retention_or_hold_ref?: string;
    readonly next_review_at?: string;
    readonly identity_digest?: string;
  } = {},
): Promise<PurgeTarget> {
  const identityDigest = options.identity_digest ?? await erasureDigest({
    exact_subject_ref: exactSubjectRef,
    location,
    canonical_ref: canonicalRef,
    provider_ref: options.provider_ref ?? null,
  });
  const targetId = await stableErasureId("erase-target", identityDigest);
  return {
    target_id: targetId,
    target_kind: "OBJECT",
    exact_subject_ref: exactSubjectRef,
    location,
    canonical_ref: canonicalRef,
    identity_digest: identityDigest,
    shared_live_reference_count: options.shared_live_reference_count ?? 0,
    ...(options.provider_ref === undefined ? {} : { provider_ref: options.provider_ref }),
    ...(options.retention_or_hold_ref === undefined
      ? {}
      : { retention_or_hold_ref: options.retention_or_hold_ref }),
    ...(options.next_review_at === undefined ? {} : { next_review_at: options.next_review_at }),
  };
}

export interface D1ErasureInventoryDependencies {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly work_bucket?: R2Bucket;
  readonly backup_offsite?: BackupErasurePort;
  readonly backup_primary_qualification?: BackupPrimaryWriterQualificationVerifier;
  readonly backup_primary_inventory?: BackupPrimaryInventoryPort;
  readonly backup_epoch_scope?: BackupEpochScopePort;
  readonly backup_producer_quiescence?: BackupProducerQuiescencePort;
  readonly now?: () => number;
}

export function createD1ErasureInventory(
  dependencies: D1ErasureInventoryDependencies,
): ErasureInventoryPort {
  return {
    async enumerate(rawRequest, fence?: ErasureFence): Promise<ErasureDependencyClosure> {
      const request = validateErasureRequest(rawRequest);
      const requestDigest = await erasureDigest(request);
      const requiresBackup = request.required_locations.includes("BackupRestorePath");
      let backupProducer: BackupProducerQuiescenceSnapshot | undefined;
      let backupCuts: BackupExportCutInventory | undefined;
      let backupInventory: BackupEpochScopeInventory | undefined;
      let backupReplay: BackupPrimaryReplaySnapshot | null = null;
      if (requiresBackup) {
        const primaryInventory = dependencies.backup_primary_inventory;
        const producerQuiescence = dependencies.backup_producer_quiescence;
        const epochScope = dependencies.backup_epoch_scope;
        if (fence === undefined || fence.erasure_id !== request.erasure_ref.id ||
            fence.revision !== request.erasure_ref.revision) {
          erasureFail("ERASURE_LEASE_LOST", "backup producer closure requires the exact acquired erasure fence", true);
        }
        if (primaryInventory === undefined || epochScope === undefined ||
            producerQuiescence === undefined) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source-scoped local backup archive authority is unavailable");
        }
        if (dependencies.backup_primary_qualification === undefined) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "persisted primary writer qualification is unavailable");
        }
        if (dependencies.backup_offsite === undefined) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "offsite backup erasure receipt adapter is unavailable");
        }
        try {
          backupProducer = await producerQuiescence.assertQuiescent({
            erasure_id: fence.erasure_id,
            revision: fence.revision,
          });
        } catch (cause) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup producer set is not authoritatively quiescent", false, cause);
        }
        backupCuts = await primaryInventory.readExportCutInventory();
        backupReplay = await primaryInventory.loadReplay({
          fence,
          now_ms: (dependencies.now ?? Date.now)(),
        });
      }
      const revisions: { readonly subject: string; readonly row: SourceRevisionInventoryRow }[] = [];
      const backupSelections: BackupInventorySelection[] = [];
      const directTargets: PurgeTarget[] = [];

      for (const exactSubjectRef of request.exact_subject_refs) {
        const parsed = parseErasureSubject(exactSubjectRef);
        if (parsed.kind === "source_revision") {
          ensureClosureCapacity(revisions.length, 1, "source revision selection");
          const row = await oneRevision(dependencies.core_database, parsed.source_revision_ref);
          revisions.push({ subject: exactSubjectRef, row });
          backupSelections.push({
            exact_subject_ref: exactSubjectRef,
            subject: {
              kind: "source-revision",
              source_id: row.source_id,
              source_owner_generation: row.source_owner_generation,
              source_revision_ref: row.source_revision_ref,
              content_sha256: row.content_sha256,
              object_residency_key_digest: row.object_residency_key_digest,
            },
          });
        } else if (parsed.kind === "source") {
          const rows = await revisionRows(dependencies.core_database, parsed.source_id);
          if (rows.length === 0) erasureFail("ERASURE_INPUT_INVALID", `source ${parsed.source_id} has no revisions`);
          ensureClosureCapacity(revisions.length, rows.length, "source revision selection");
          for (const row of rows) revisions.push({ subject: exactSubjectRef, row });
          backupSelections.push({
            exact_subject_ref: exactSubjectRef,
            subject: {
              kind: "source",
              source_id: parsed.source_id,
              source_owner_generation: await sourceOwnerGeneration(dependencies.core_database, parsed.source_id),
            },
          });
        } else if (parsed.kind === "evidence_handle") {
          await verifyEvidenceHandleRoot(dependencies.core_database, parsed.handle_id, parsed.revision);
          ensureClosureCapacity(directTargets.length, 2, "direct erasure target selection");
          directTargets.push(await target(
            exactSubjectRef,
            "CanonicalPayload",
            `d1-core:evidence-handle:${parsed.handle_id}:${parsed.revision}`,
          ));
          directTargets.push(await target(
            exactSubjectRef,
            "RouteContinuation",
            `d1-core:route:evidence-handle:${parsed.handle_id}:${parsed.revision}`,
          ));
        } else {
          await verifyScopeSnapshotRoots(dependencies.core_database, parsed.snapshot_id, parsed.revision);
          ensureClosureCapacity(directTargets.length, 2, "direct erasure target selection");
          directTargets.push(await target(
            exactSubjectRef,
            "CanonicalPayload",
            `d1-core:scope-snapshot:${parsed.snapshot_id}:${parsed.revision}`,
          ));
          directTargets.push(await target(
            exactSubjectRef,
            "RouteContinuation",
            `d1-core:route:scope-snapshot:${parsed.snapshot_id}:${parsed.revision}`,
          ));
        }
      }

      const selectedRevisions = new Set(revisions.map((entry) => entry.row.source_revision_ref));
      const rawByRevision = new Map<string, Awaited<ReturnType<typeof enumerateRawIngestDependencies>>>();
      const rawPendingBySubject = new Map<string, RawPendingTargetOptions>();
      const rawBlobOwners = new Map<string, string>();
      const rawBlobPending = new Map<string, RawPendingTargetOptions>();
      for (const { subject, row } of revisions) {
        if (!rawByRevision.has(row.source_revision_ref)) {
          const raw = await enumerateRawIngestDependencies(dependencies.core_database, {
            source_revision_ref: row.source_revision_ref,
            content_sha256: row.content_sha256,
            selected_source_revision_refs: selectedRevisions,
          });
          rawByRevision.set(row.source_revision_ref, raw);
          if (raw !== null) {
            for (const blob of raw.blobs) {
              if (!rawBlobOwners.has(blob.object_key)) rawBlobOwners.set(blob.object_key, subject);
              if (raw.pending !== undefined) rawBlobPending.set(blob.object_key, earlierPending(rawBlobPending.get(blob.object_key), raw.pending));
            }
          }
        }
        const raw = rawByRevision.get(row.source_revision_ref);
        if (raw?.pending !== undefined) rawPendingBySubject.set(subject, earlierPending(rawPendingBySubject.get(subject), raw.pending));
      }
      const generated: PurgeTarget[] = [...directTargets];
      if (request.required_locations.includes("Projection") && dependencies.work_bucket !== undefined) {
        for (const { subject, row } of revisions) {
          const authorityBefore = await readEmptyProofAuthorityDigest(
            dependencies.core_database,
            row.source_revision_ref,
            subject,
            "Projection",
          );
          const snapshot = await readR2WorkEmptySnapshot(dependencies.work_bucket, row.source_revision_ref);
          const authorityAfter = await readEmptyProofAuthorityDigest(
            dependencies.core_database,
            row.source_revision_ref,
            subject,
            "Projection",
          );
          if (authorityBefore !== authorityAfter) {
            erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source Work writer authority changed during exact dependency enumeration");
          }
          if (snapshot.keys.length === 0) {
            const work = await makeR2WorkEmptyProofTarget(
              dependencies.core_database,
              dependencies.work_bucket,
              requestDigest,
              subject,
              row.source_revision_ref,
            );
            if (work.target === null || work.prefix !== snapshot.prefix) {
              erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source Work inventory changed while creating its empty proof");
            }
            generated.push(work.target);
            continue;
          }
          const workKeys = [...snapshot.keys];
          for (const key of workKeys) {
            if (!key.startsWith(snapshot.prefix) || key.endsWith("/") ||
                hasSortedKeyPrefix(workKeys, `${key}/`)) {
              erasureFail("ERASURE_IDENTITY_CONFLICT", "source Work object inventory is not an exact, non-overlapping key set");
            }
          }
          ensureClosureCapacity(generated.length, workKeys.length, "exact source-residency Work objects");
          for (const key of workKeys) {
            generated.push(await target(subject, "Projection", `r2-work-prefix:${key}`));
          }
        }
      } else if (request.required_locations.includes("Projection") && revisions.length > 0) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "exact source-residency Work inventory is unavailable");
      }
      if (requiresBackup) {
        const primaryInventory = dependencies.backup_primary_inventory;
        const epochScope = dependencies.backup_epoch_scope;
        if (primaryInventory === undefined || epochScope === undefined) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source-scoped local backup archive authority is unavailable");
        }
        const resolved = await resolveBackupTargets({
          primary_inventory: primaryInventory,
          epoch_scope: epochScope,
          backup_replay: backupReplay,
          backup_selections: backupSelections,
          current_target_count: generated.length,
          create_target: (subject, location, canonical_ref) => target(subject, location, canonical_ref),
        });
        backupInventory = resolved.inventory;
        generated.push(...resolved.targets);
      }
      for (const { subject, row } of revisions) {
        const raw = rawByRevision.get(row.source_revision_ref) ?? null;
        const rawPending = raw?.pending ?? {};
        ensureClosureCapacity(generated.length, raw === null ? 3 : 4, "canonical erasure targets");
        generated.push(await target(subject, "CanonicalPayload", `d1-core:source-revision:${row.source_revision_ref}`, rawPending));
        generated.push(await target(subject, "OperationalRecovery", `d1-core:operational:${row.source_revision_ref}`, rawPending));
        generated.push(await target(subject, "RouteContinuation", `d1-core:route:source-revision:${row.source_revision_ref}`, rawPending));
        if (raw !== null) {
          generated.push(await target(subject, "OperationalRecovery", raw.d1_canonical_ref, rawPending));
          ensureClosureCapacity(generated.length, raw.blobs.length, "raw ingest R2 targets");
          for (const blob of raw.blobs) {
            if (rawBlobOwners.get(blob.object_key) !== subject) continue;
            generated.push(await target(subject, "Blob", `r2-evidence:${blob.object_key}`, {
              ...(rawBlobPending.get(blob.object_key) ?? rawPending),
              shared_live_reference_count: blob.shared_live_reference_count,
            }));
          }
        }
        if (row.original_r2_key !== undefined) {
          ensureClosureCapacity(generated.length, 1, "R2 erasure targets");
          generated.push(await target(subject, "Blob", `r2-evidence:${row.original_r2_key}`, {
            ...(rawBlobPending.get(row.original_r2_key) ?? rawPending),
            shared_live_reference_count: 0,
          }));
        }
        if (row.normalized_artifact_ref !== undefined) {
          ensureClosureCapacity(generated.length, 1, "R2 erasure targets");
          generated.push(await target(subject, "Blob", `r2-evidence:${row.normalized_artifact_ref}`, {
            ...(rawBlobPending.get(row.normalized_artifact_ref) ?? rawPending),
            shared_live_reference_count: 0,
          }));
        }
        const projectionRows = await projections(dependencies.core_database, row.source_revision_ref);
        const providerEffects = request.required_locations.includes("ProviderCopy")
          ? await managedProviderEffects(dependencies.core_database, row.source_revision_ref)
          : { targets: [], project_copy_generations: new Set<string>() };
        ensureClosureCapacity(generated.length, providerEffects.targets.length, "exact provider erasure targets");
        for (const effect of providerEffects.targets) {
          generated.push(await target(
            subject,
            "ProviderCopy",
            `ai-search:${effect.instance_id}:${effect.key}`,
            { ...rawPending, provider_ref: effect.generation },
          ));
        }
        if (request.required_locations.includes("Index") && projectionRows.length === 0) {
          const proof = await makeD1SearchEmptyProofFields(
            dependencies.core_database,
            dependencies.search_database,
            requestDigest,
            subject,
            row.source_revision_ref,
          );
          generated.push(await createEmptyLocationProofTarget(proof));
        }
        for (const projection of projectionRows) {
          if (request.required_locations.includes("Index")) {
            ensureClosureCapacity(generated.length, 1, "index erasure targets");
            generated.push(await target(
              subject,
              "Index",
              `d1-search:${row.source_revision_ref}:${projection.projection_generation}`,
              rawPending,
            ));
          }
          if (request.required_locations.includes("ProviderCopy") &&
              projection.semantic_instance_id !== undefined &&
              !providerEffects.project_copy_generations.has(projection.projection_generation)) {
            erasureFail("ERASURE_CLOSURE_INCOMPLETE", "semantic projection lacks exact durable provider-key/readback rows");
          }
        }
      }

      const selectedRegistrySubjects = [...new Set([
        ...request.exact_subject_refs,
        ...revisions.map(({ row }) => `source-revision:${row.source_revision_ref}`),
      ])].sort();
      const selectedSubjects = new Set(selectedRegistrySubjects);
      const registeredSharedCounts = new Map<string, number>();
      const registeredDependencies = await registered(dependencies.core_database, selectedRegistrySubjects);
      ensureClosureCapacity(generated.length, registeredDependencies.length, "registered erasure targets");
      for (const dependency of registeredDependencies) {
        const registryR2Key = evidenceR2Key(dependency.canonical_ref);
        if (registryR2Key !== undefined && dependency.location !== "Blob") {
          erasureFail("ERASURE_IDENTITY_CONFLICT", "registered R2 evidence target has an invalid location");
        }
        if (registryR2Key !== undefined) {
          if (dependency.provider_ref !== undefined) {
            erasureFail("ERASURE_IDENTITY_CONFLICT", "registered R2 evidence target has a provider identity");
          }
          const expectedIdentity = await erasureDigest({
            exact_subject_ref: dependency.exact_subject_ref,
            location: dependency.location,
            canonical_ref: dependency.canonical_ref,
            provider_ref: null,
          });
          if (dependency.object_identity_digest !== expectedIdentity) {
            erasureFail("ERASURE_IDENTITY_CONFLICT", "registered R2 evidence target identity is not canonical");
          }
        }
        let liveSharedReferences = 0;
        if (dependency.shared_reference_key !== undefined) {
          const cached = registeredSharedCounts.get(dependency.shared_reference_key);
          liveSharedReferences = cached ?? await registeredSharedCount(
            dependencies.core_database,
            dependency.shared_reference_key,
            selectedSubjects,
          );
          registeredSharedCounts.set(dependency.shared_reference_key, liveSharedReferences);
        }
        let rawPending = rawPendingBySubject.get(dependency.exact_subject_ref);
        if (registryR2Key !== undefined) {
          const blobPending = rawBlobPending.get(registryR2Key);
          if (blobPending !== undefined) rawPending = earlierPending(rawPending, blobPending);
        }
        const registeredTarget = await target(
          dependency.exact_subject_ref,
          dependency.location,
          dependency.canonical_ref,
          {
            ...(dependency.provider_ref === undefined ? {} : { provider_ref: dependency.provider_ref }),
            ...(dependency.retention_or_hold_ref === undefined ? {} : { retention_or_hold_ref: dependency.retention_or_hold_ref }),
            ...(dependency.next_review_at === undefined ? {} : { next_review_at: dependency.next_review_at }),
            identity_digest: dependency.object_identity_digest,
            shared_live_reference_count: liveSharedReferences,
          },
        );
        generated.push(applyPending(
          registeredTarget,
          rawPending,
        ));
      }

      const requested = new Set(request.required_locations);
      const unique = new Map<string, PurgeTarget>();
      const refreshed: PurgeTarget[] = [];
      const r2Counts = new Map<string, number>();
      for (const item of generated.filter((candidate) => requested.has(candidate.location))) {
        refreshed.push(await refreshR2SharedReferenceCount(
          dependencies.core_database,
          item,
          selectedRevisions,
          r2Counts,
        ));
      }
      for (const item of refreshed) {
        const key = `${item.location}\u0000${item.canonical_ref}`;
        const existing = unique.get(key);
        unique.set(key, existing === undefined ? item : mergeTarget(existing, item));
      }
      const missing = request.required_locations.filter((location) =>
        ![...unique.values()].some((candidate) => candidate.location === location));
      if (missing.length > 0) {
        erasureFail(
          "ERASURE_CLOSURE_INCOMPLETE",
          `required erasure locations have no authoritative enumerated target: ${missing.join(",")}`,
        );
      }
      const targets = [...unique.values()].sort((left, right) => {
        const leftKey = `${left.location}\u0000${left.canonical_ref}`;
        const rightKey = `${right.location}\u0000${right.canonical_ref}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      const closureDigest = await erasureDigest(targets.map((item) => ({
        target_id: item.target_id,
        target_kind: item.target_kind,
        exact_subject_ref: item.exact_subject_ref,
        location: item.location,
        canonical_ref: item.canonical_ref,
        provider_ref: item.provider_ref ?? null,
        identity_digest: item.identity_digest,
        shared_live_reference_count: item.shared_live_reference_count,
        retention_or_hold_ref: item.retention_or_hold_ref ?? null,
        next_review_at: item.next_review_at ?? null,
      })));
      const closure: ErasureDependencyClosure = {
        erasure_ref: request.erasure_ref,
        request_digest: requestDigest,
        closure_digest: closureDigest,
        targets,
      };
      if (requiresBackup) {
        const primaryInventory = dependencies.backup_primary_inventory;
        const producerQuiescence = dependencies.backup_producer_quiescence;
        const qualificationVerifier = dependencies.backup_primary_qualification;
        if (fence === undefined || backupProducer === undefined || backupCuts === undefined ||
            backupInventory === undefined || primaryInventory === undefined || producerQuiescence === undefined ||
            qualificationVerifier === undefined) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary closure lost a required authority input");
        }
        let currentProducer: BackupProducerQuiescenceSnapshot;
        try {
          currentProducer = await producerQuiescence.assertQuiescent({
            erasure_id: fence.erasure_id,
            revision: fence.revision,
          });
        } catch (cause) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup producer snapshot changed before closure sealing", false, cause);
        }
        const currentCuts = await primaryInventory.readExportCutInventory();
        if (currentProducer.claims_digest !== backupProducer.claims_digest ||
            currentProducer.canonical_epochs_digest !== backupProducer.canonical_epochs_digest ||
            currentCuts.inventory_digest !== backupCuts.inventory_digest) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup producer or cut inventory changed during closure enumeration");
        }
        const backupTargets = targets.filter((item) => item.location === "BackupRestorePath");
        const qualificationInput = backupPrimaryQualificationInput(
          fence,
          requestDigest,
          currentProducer,
          currentCuts,
          backupInventory.primary_parts,
        );
        let qualification: BackupPrimaryWriterQualificationReceipt;
        try {
          qualification = await qualificationVerifier.assertCurrentQualification(qualificationInput);
        } catch (cause) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "current primary writer qualification is unavailable", false, cause);
        }
        if (backupReplay !== null) {
          const previousTargets = [...backupReplay.targets.values()]
            .sort((left, right) => left.target_id.localeCompare(right.target_id));
          const currentBackupTargets = backupTargets.slice()
            .sort((left, right) => left.target_id.localeCompare(right.target_id));
          if (closureDigest !== backupReplay.header.erasure_closure_digest ||
              canonicalErasureJson(currentBackupTargets) !== canonicalErasureJson(previousTargets) ||
              currentProducer.claims_digest !== backupReplay.header.producer_claims_digest ||
              currentProducer.canonical_epoch_count !== backupReplay.header.canonical_epoch_count ||
              currentProducer.canonical_epochs_digest !== backupReplay.header.canonical_epochs_digest ||
              currentCuts.inventory_digest !== backupReplay.header.export_cut_inventory_digest) {
            erasureFail("ERASURE_IDENTITY_CONFLICT", "recovered current closure diverges from its immutable original plan and producer pins");
          }
          await sealBackupPrimaryHandoff(
            dependencies.core_database,
            fence,
            backupInventory.primary_parts,
            qualification,
          );
        } else {
          await primaryInventory.sealClosure({
            now: dependencies.now ?? Date.now,
            request,
            fence,
            request_sha256: requestDigest,
            closure_digest: closureDigest,
            producer: currentProducer,
            cuts: currentCuts,
            qualification,
            primary_parts: backupInventory.primary_parts,
            targets: backupTargets,
          });
        }
      }
      return closure;
    },
  };
}
