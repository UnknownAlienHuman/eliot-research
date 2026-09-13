import type {
  PurgeLocation,
  ErasureDependencyClosure,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  assertErasureSha256,
  assertErasureText,
  erasureDigest,
  erasureFail,
  erasureSha256Utf8,
  parseErasureSubject,
  stableErasureId,
  validateErasureRequest,
} from "./canonical.js";
import type {
  BackupEpochInventoryRow,
  ErasureInventoryPort,
  ProjectionInventoryRow,
  ProjectionItemInventoryRow,
  RegisteredDependencyRow,
  SourceRevisionInventoryRow,
} from "./types.js";
import { enumerateRawIngestDependencies } from "./raw-ingest-inventory.js";
import {
  applyPending,
  earlierPending,
  evidenceR2Key,
  mergeTarget,
  refreshR2SharedReferenceCount,
  type RawPendingTargetOptions,
} from "./erasure-targets.js";

interface RevisionRow {
  readonly source_revision_ref: unknown;
  readonly source_id: unknown;
  readonly original_r2_key: unknown;
  readonly normalized_artifact_ref: unknown;
  readonly content_sha256: unknown;
  readonly object_residency_key_digest: unknown;
  readonly purge_state: unknown;
}

interface ProjectionRow {
  readonly source_revision_ref: unknown;
  readonly projection_generation: unknown;
  readonly work_manifest_ref: unknown;
  readonly semantic_instance_id: unknown;
  readonly semantic_generation: unknown;
  readonly state: unknown;
}

interface ItemRow {
  readonly item_key: unknown;
  readonly projection_generation: unknown;
}

interface BackupRow {
  readonly backup_epoch_id: unknown;
  readonly offsite_copy_ref: unknown;
  readonly purge_ledger_revision: unknown;
  readonly verification_state: unknown;
}

interface RegistryRow {
  readonly dependency_id: unknown;
  readonly exact_subject_ref: unknown;
  readonly location: unknown;
  readonly canonical_ref: unknown;
  readonly provider_ref: unknown;
  readonly object_identity_digest: unknown;
  readonly shared_reference_key: unknown;
  readonly retention_or_hold_ref: unknown;
  readonly next_review_at: unknown;
}

interface InventoryQueryResult<T> {
  readonly success?: boolean;
  readonly results?: readonly T[];
}

const LOCATIONS: readonly PurgeLocation[] = [
  "CanonicalPayload",
  "Projection",
  "Index",
  "Blob",
  "OperationalRecovery",
  "ProviderCopy",
  "BackupRestorePath",
  "RouteContinuation",
];
const INVENTORY_ROW_LIMIT = 10_000;
const INVENTORY_FETCH_LIMIT = INVENTORY_ROW_LIMIT + 1;
const MAX_CLOSURE_TARGETS = 100_000;

function boundedRows<T>(result: InventoryQueryResult<T>, label: string): readonly T[] {
  if (result.success === false) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} failed`, true);
  const rows = result.results ?? [];
  if (rows.length > INVENTORY_ROW_LIMIT) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", `${label} exceeds the bounded ${INVENTORY_ROW_LIMIT}-row inventory`);
  }
  return rows;
}

function ensureClosureCapacity(current: number, additional: number, label: string): void {
  if (!Number.isSafeInteger(additional) || additional < 0 || current > MAX_CLOSURE_TARGETS - additional) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", `${label} exceeds the bounded ${MAX_CLOSURE_TARGETS}-target closure`);
  }
}

function purgeLocation(value: unknown): PurgeLocation {
  if (!LOCATIONS.includes(value as PurgeLocation)) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored purge location is invalid");
  }
  return value as PurgeLocation;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return assertErasureText(value, label, 2048);
}

function decodeRevision(row: RevisionRow): SourceRevisionInventoryRow {
  const purgeState = assertErasureIdentifier(row.purge_state, "source purge state");
  const originalR2Key = optionalText(row.original_r2_key, "original R2 key");
  const normalizedArtifactRef = optionalText(row.normalized_artifact_ref, "normalized artifact ref");
  return {
    source_revision_ref: assertErasureIdentifier(row.source_revision_ref, "source revision ref"),
    source_id: assertErasureIdentifier(row.source_id, "source ID"),
    content_sha256: assertErasureSha256(row.content_sha256, "source content digest"),
    object_residency_key_digest: assertErasureSha256(
      row.object_residency_key_digest,
      "source residency digest",
    ),
    purge_state: purgeState,
    ...(originalR2Key === undefined ? {} : { original_r2_key: originalR2Key }),
    ...(normalizedArtifactRef === undefined ? {} : { normalized_artifact_ref: normalizedArtifactRef }),
  };
}

function decodeProjection(row: ProjectionRow): ProjectionInventoryRow {
  const workManifestRef = optionalText(row.work_manifest_ref, "projection work manifest");
  const semanticInstanceId = optionalText(row.semantic_instance_id, "semantic instance");
  const semanticGeneration = optionalText(row.semantic_generation, "semantic generation");
  return {
    source_revision_ref: assertErasureIdentifier(row.source_revision_ref, "projection source revision"),
    projection_generation: assertErasureIdentifier(row.projection_generation, "projection generation"),
    state: assertErasureIdentifier(row.state, "projection state"),
    ...(workManifestRef === undefined ? {} : { work_manifest_ref: workManifestRef }),
    ...(semanticInstanceId === undefined ? {} : { semantic_instance_id: semanticInstanceId }),
    ...(semanticGeneration === undefined ? {} : { semantic_generation: semanticGeneration }),
  };
}

function decodeItem(row: ItemRow): ProjectionItemInventoryRow {
  return {
    item_key: assertErasureIdentifier(row.item_key, "projection item key"),
    projection_generation: assertErasureIdentifier(row.projection_generation, "projection generation"),
  };
}

function decodeBackup(row: BackupRow): BackupEpochInventoryRow {
  if (
    typeof row.purge_ledger_revision !== "number" ||
    !Number.isSafeInteger(row.purge_ledger_revision) ||
    row.purge_ledger_revision < 0
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "backup purge-ledger revision is invalid");
  }
  return {
    backup_epoch_id: assertErasureIdentifier(row.backup_epoch_id, "backup epoch ID"),
    offsite_copy_ref: assertErasureText(row.offsite_copy_ref, "offsite copy ref", 2048),
    purge_ledger_revision: row.purge_ledger_revision,
    verification_state: assertErasureIdentifier(row.verification_state, "backup verification state"),
  };
}

function decodeRegistry(row: RegistryRow): RegisteredDependencyRow {
  const providerRef = optionalText(row.provider_ref, "provider ref");
  const sharedReferenceKey = optionalText(row.shared_reference_key, "shared reference key");
  const retentionOrHoldRef = optionalText(row.retention_or_hold_ref, "retention or hold ref");
  const nextReviewAt = optionalText(row.next_review_at, "next review time");
  return {
    dependency_id: assertErasureIdentifier(row.dependency_id, "dependency ID"),
    exact_subject_ref: assertErasureIdentifier(row.exact_subject_ref, "registered subject ref"),
    location: purgeLocation(row.location),
    canonical_ref: assertErasureText(row.canonical_ref, "registered canonical ref", 2048),
    object_identity_digest: assertErasureSha256(row.object_identity_digest, "registered identity digest"),
    ...(providerRef === undefined ? {} : { provider_ref: providerRef }),
    ...(sharedReferenceKey === undefined ? {} : { shared_reference_key: sharedReferenceKey }),
    ...(retentionOrHoldRef === undefined ? {} : { retention_or_hold_ref: retentionOrHoldRef }),
    ...(nextReviewAt === undefined ? {} : { next_review_at: nextReviewAt }),
  };
}

async function providerKey(sourceRevisionRef: string, itemKey: string): Promise<string> {
  const sourceDigest = await erasureSha256Utf8(["source", sourceRevisionRef].join("\u0000"));
  return `${sourceDigest.slice(0, 24)}-${itemKey}.md`;
}

function workPrefix(manifestRef: string): string {
  const marker = "/manifests/";
  const index = manifestRef.lastIndexOf(marker);
  if (index < 1) erasureFail("ERASURE_IDENTITY_CONFLICT", "projection manifest ref has no generation prefix");
  return manifestRef.slice(0, index);
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

async function revisionRows(database: D1Database, sourceId: string): Promise<readonly SourceRevisionInventoryRow[]> {
  const result = await database.prepare(
    "SELECT source_revision_ref,source_id,original_r2_key,normalized_artifact_ref," +
    "content_sha256,object_residency_key_digest,purge_state FROM source_revision " +
    `WHERE source_id=?1 ORDER BY source_revision_ref LIMIT ${INVENTORY_FETCH_LIMIT}`,
  ).bind(sourceId).all<RevisionRow>();
  return boundedRows(result, "source revision inventory").map(decodeRevision);
}

async function oneRevision(database: D1Database, revisionRef: string): Promise<SourceRevisionInventoryRow> {
  const row = await database.prepare(
    "SELECT source_revision_ref,source_id,original_r2_key,normalized_artifact_ref," +
    "content_sha256,object_residency_key_digest,purge_state FROM source_revision " +
    "WHERE source_revision_ref=?1 LIMIT 1",
  ).bind(revisionRef).first<RevisionRow>();
  if (row === null) erasureFail("ERASURE_INPUT_INVALID", `source revision ${revisionRef} does not exist`);
  return decodeRevision(row);
}

async function projections(database: D1Database, revisionRef: string): Promise<readonly ProjectionInventoryRow[]> {
  const result = await database.prepare(
    "SELECT source_revision_ref,projection_generation,work_manifest_ref,semantic_instance_id," +
    "semantic_generation,state FROM projection_generation WHERE source_revision_ref=?1 " +
    `ORDER BY projection_generation LIMIT ${INVENTORY_FETCH_LIMIT}`,
  ).bind(revisionRef).all<ProjectionRow>();
  return boundedRows(result, "projection inventory").map(decodeProjection);
}

async function items(database: D1Database, revisionRef: string, generation: string): Promise<readonly ProjectionItemInventoryRow[]> {
  const result = await database.prepare(
    "SELECT item_key,projection_generation FROM projection_item WHERE source_revision_ref=?1 " +
    `AND projection_generation=?2 ORDER BY item_key LIMIT ${INVENTORY_FETCH_LIMIT}`,
  ).bind(revisionRef, generation).all<ItemRow>();
  return boundedRows(result, "projection item inventory").map(decodeItem);
}

async function backups(database: D1Database): Promise<readonly BackupEpochInventoryRow[]> {
  const result = await database.prepare(
    "SELECT backup_epoch_id,offsite_copy_ref,purge_ledger_revision,verification_state " +
    `FROM backup_epoch WHERE verification_state='VERIFIED' ORDER BY backup_epoch_id LIMIT ${INVENTORY_FETCH_LIMIT}`,
  ).all<BackupRow>();
  return boundedRows(result, "backup inventory").map(decodeBackup);
}

async function registered(
  database: D1Database,
  subjectRefs: readonly string[],
): Promise<readonly RegisteredDependencyRow[]> {
  const output: RegisteredDependencyRow[] = [];
  for (const subjectRef of subjectRefs) {
    const result = await database.prepare(
      "SELECT dependency_id,exact_subject_ref,location,canonical_ref,provider_ref," +
      "object_identity_digest,shared_reference_key,retention_or_hold_ref,next_review_at " +
      "FROM erasure_dependency_registry WHERE exact_subject_ref=?1 AND state='ACTIVE' " +
      `ORDER BY dependency_id LIMIT ${INVENTORY_FETCH_LIMIT}`,
    ).bind(subjectRef).all<RegistryRow>();
    const rows = boundedRows(result, "registered dependency inventory");
    ensureClosureCapacity(output.length, rows.length, "registered dependency inventory");
    output.push(...rows.map(decodeRegistry));
  }
  return output;
}

async function registeredSharedCount(
  database: D1Database,
  sharedReferenceKey: string,
  selectedSubjects: ReadonlySet<string>,
): Promise<number> {
  const result = await database.prepare(
    "SELECT exact_subject_ref FROM erasure_dependency_registry " +
    `WHERE shared_reference_key=?1 AND state='ACTIVE' ORDER BY exact_subject_ref LIMIT ${INVENTORY_FETCH_LIMIT}`,
  ).bind(sharedReferenceKey).all<{ exact_subject_ref: unknown }>();
  const live = new Set<string>();
  for (const row of boundedRows(result, "registered shared-reference inventory")) {
    const subject = assertErasureIdentifier(row.exact_subject_ref, "shared dependency subject");
    if (!selectedSubjects.has(subject)) live.add(subject);
  }
  return live.size;
}

export interface D1ErasureInventoryDependencies {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
}

export function createD1ErasureInventory(
  dependencies: D1ErasureInventoryDependencies,
): ErasureInventoryPort {
  return {
    async enumerate(rawRequest): Promise<ErasureDependencyClosure> {
      const request = validateErasureRequest(rawRequest);
      const requestDigest = await erasureDigest(request);
      const revisions: { readonly subject: string; readonly row: SourceRevisionInventoryRow }[] = [];
      const directTargets: PurgeTarget[] = [];

      for (const exactSubjectRef of request.exact_subject_refs) {
        const parsed = parseErasureSubject(exactSubjectRef);
        if (parsed.kind === "source_revision") {
          ensureClosureCapacity(revisions.length, 1, "source revision selection");
          revisions.push({ subject: exactSubjectRef, row: await oneRevision(dependencies.core_database, parsed.source_revision_ref) });
        } else if (parsed.kind === "source") {
          const rows = await revisionRows(dependencies.core_database, parsed.source_id);
          if (rows.length === 0) erasureFail("ERASURE_INPUT_INVALID", `source ${parsed.source_id} has no revisions`);
          ensureClosureCapacity(revisions.length, rows.length, "source revision selection");
          for (const row of rows) revisions.push({ subject: exactSubjectRef, row });
        } else if (parsed.kind === "evidence_handle") {
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
      const backupRows = request.required_locations.includes("BackupRestorePath")
        ? await backups(dependencies.core_database)
        : [];

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
        for (const projection of await projections(dependencies.core_database, row.source_revision_ref)) {
          if (projection.work_manifest_ref !== undefined) {
            ensureClosureCapacity(generated.length, 1, "projection erasure targets");
            generated.push(await target(
              subject,
              "Projection",
              `r2-work-prefix:${workPrefix(projection.work_manifest_ref)}`,
              rawPending,
            ));
          }
          ensureClosureCapacity(generated.length, 1, "index erasure targets");
          generated.push(await target(
            subject,
            "Index",
            `d1-search:${row.source_revision_ref}:${projection.projection_generation}`,
            rawPending,
          ));
          if (projection.semantic_instance_id !== undefined) {
            if (projection.semantic_generation === undefined) {
              erasureFail("ERASURE_CLOSURE_INCOMPLETE", "active semantic projection lacks an exact provider generation");
            }
            const projectionItems = await items(
              dependencies.search_database,
              row.source_revision_ref,
              projection.projection_generation,
            );
            ensureClosureCapacity(generated.length, projectionItems.length, "provider erasure targets");
            for (const item of projectionItems) {
              const key = await providerKey(row.source_revision_ref, item.item_key);
              generated.push(await target(
                subject,
                "ProviderCopy",
                `ai-search:${projection.semantic_instance_id}:${key}`,
                { ...rawPending, provider_ref: projection.semantic_generation },
              ));
            }
          }
        }
        ensureClosureCapacity(generated.length, backupRows.length, "backup erasure targets");
        for (const backup of backupRows) {
          generated.push(await target(
            subject,
            "BackupRestorePath",
            `backup:${backup.backup_epoch_id}`,
            { ...rawPending, provider_ref: backup.offsite_copy_ref },
          ));
        }
      }

      const selectedSubjects = new Set(request.exact_subject_refs);
      const registeredSharedCounts = new Map<string, number>();
      const registeredDependencies = await registered(dependencies.core_database, request.exact_subject_refs);
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
      return {
        erasure_ref: request.erasure_ref,
        request_digest: requestDigest,
        closure_digest: closureDigest,
        targets,
      };
    },
  };
}
