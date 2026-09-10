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
    readonly target_kind?: "OBJECT" | "LOCATION_EMPTY_PROOF";
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
    target_kind: options.target_kind ?? "OBJECT",
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
    "WHERE source_id=?1 ORDER BY source_revision_ref LIMIT 10000",
  ).bind(sourceId).all<RevisionRow>();
  if ((result as { readonly success?: boolean }).success === false) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "source revision inventory failed", true);
  return (result.results ?? []).map(decodeRevision);
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
    "AND state<>'RETIRED' ORDER BY projection_generation LIMIT 10000",
  ).bind(revisionRef).all<ProjectionRow>();
  if ((result as { readonly success?: boolean }).success === false) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "projection inventory failed", true);
  return (result.results ?? []).map(decodeProjection);
}

async function items(database: D1Database, revisionRef: string, generation: string): Promise<readonly ProjectionItemInventoryRow[]> {
  const result = await database.prepare(
    "SELECT item_key,projection_generation FROM projection_item WHERE source_revision_ref=?1 " +
    "AND projection_generation=?2 ORDER BY item_key LIMIT 10000",
  ).bind(revisionRef, generation).all<ItemRow>();
  if ((result as { readonly success?: boolean }).success === false) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "projection item inventory failed", true);
  return (result.results ?? []).map(decodeItem);
}

async function backups(database: D1Database): Promise<readonly BackupEpochInventoryRow[]> {
  const result = await database.prepare(
    "SELECT backup_epoch_id,offsite_copy_ref,purge_ledger_revision,verification_state " +
    "FROM backup_epoch WHERE verification_state='VERIFIED' ORDER BY backup_epoch_id LIMIT 10000",
  ).all<BackupRow>();
  if ((result as { readonly success?: boolean }).success === false) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup inventory failed", true);
  return (result.results ?? []).map(decodeBackup);
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
      "ORDER BY dependency_id LIMIT 10000",
    ).bind(subjectRef).all<RegistryRow>();
    if ((result as { readonly success?: boolean }).success === false) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "registered dependency inventory failed", true);
    output.push(...(result.results ?? []).map(decodeRegistry));
  }
  return output;
}

async function sharedCount(
  database: D1Database,
  keyColumn: "original_r2_key" | "normalized_artifact_ref",
  key: string,
  selectedRevisions: ReadonlySet<string>,
): Promise<number> {
  const result = await database.prepare(
    `SELECT source_revision_ref FROM source_revision WHERE ${keyColumn}=?1 AND purge_state='LIVE' ` +
    "ORDER BY source_revision_ref LIMIT 10000",
  ).bind(key).all<{ source_revision_ref: string }>();
  if ((result as { readonly success?: boolean }).success === false) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "shared-object inventory failed", true);
  return (result.results ?? []).filter((row) => !selectedRevisions.has(row.source_revision_ref)).length;
}

async function registeredSharedCount(
  database: D1Database,
  sharedReferenceKey: string,
  selectedSubjects: ReadonlySet<string>,
): Promise<number> {
  const result = await database.prepare(
    "SELECT exact_subject_ref FROM erasure_dependency_registry " +
    "WHERE shared_reference_key=?1 AND state='ACTIVE' ORDER BY exact_subject_ref LIMIT 10000",
  ).bind(sharedReferenceKey).all<{ exact_subject_ref: unknown }>();
  if ((result as { readonly success?: boolean }).success === false) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "registered shared-reference inventory failed", true);
  }
  const live = new Set<string>();
  for (const row of result.results ?? []) {
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
          revisions.push({ subject: exactSubjectRef, row: await oneRevision(dependencies.core_database, parsed.source_revision_ref) });
        } else if (parsed.kind === "source") {
          const rows = await revisionRows(dependencies.core_database, parsed.source_id);
          if (rows.length === 0) erasureFail("ERASURE_INPUT_INVALID", `source ${parsed.source_id} has no revisions`);
          rows.forEach((row) => revisions.push({ subject: exactSubjectRef, row }));
        } else if (parsed.kind === "evidence_handle") {
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
      const generated: PurgeTarget[] = [...directTargets];
      const backupRows = request.required_locations.includes("BackupRestorePath")
        ? await backups(dependencies.core_database)
        : [];

      for (const { subject, row } of revisions) {
        generated.push(await target(subject, "CanonicalPayload", `d1-core:source-revision:${row.source_revision_ref}`));
        generated.push(await target(subject, "OperationalRecovery", `d1-core:operational:${row.source_revision_ref}`));
        generated.push(await target(subject, "RouteContinuation", `d1-core:route:source-revision:${row.source_revision_ref}`));
        if (row.original_r2_key !== undefined) {
          generated.push(await target(subject, "Blob", `r2-evidence:${row.original_r2_key}`, {
            shared_live_reference_count: await sharedCount(
              dependencies.core_database,
              "original_r2_key",
              row.original_r2_key,
              selectedRevisions,
            ),
          }));
        }
        if (row.normalized_artifact_ref !== undefined) {
          generated.push(await target(subject, "Blob", `r2-evidence:${row.normalized_artifact_ref}`, {
            shared_live_reference_count: await sharedCount(
              dependencies.core_database,
              "normalized_artifact_ref",
              row.normalized_artifact_ref,
              selectedRevisions,
            ),
          }));
        }
        for (const projection of await projections(dependencies.core_database, row.source_revision_ref)) {
          if (projection.work_manifest_ref !== undefined) {
            generated.push(await target(
              subject,
              "Projection",
              `r2-work-prefix:${workPrefix(projection.work_manifest_ref)}`,
            ));
          }
          generated.push(await target(
            subject,
            "Index",
            `d1-search:${row.source_revision_ref}:${projection.projection_generation}`,
          ));
          if (projection.semantic_instance_id !== undefined) {
            const projectionItems = await items(
              dependencies.search_database,
              row.source_revision_ref,
              projection.projection_generation,
            );
            for (const item of projectionItems) {
              const key = await providerKey(row.source_revision_ref, item.item_key);
              generated.push(await target(
                subject,
                "ProviderCopy",
                `ai-search:${projection.semantic_instance_id}:${key}`,
                { provider_ref: projection.semantic_generation ?? "unknown-generation" },
              ));
            }
          }
        }
        for (const backup of backupRows) {
          generated.push(await target(
            subject,
            "BackupRestorePath",
            `backup:${backup.backup_epoch_id}`,
            { provider_ref: backup.offsite_copy_ref },
          ));
        }
      }

      const selectedSubjects = new Set(request.exact_subject_refs);
      const registeredSharedCounts = new Map<string, number>();
      for (const dependency of await registered(dependencies.core_database, request.exact_subject_refs)) {
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
        generated.push(await target(
          dependency.exact_subject_ref,
          dependency.location,
          dependency.canonical_ref,
          {
            ...(dependency.provider_ref === undefined ? {} : { provider_ref: dependency.provider_ref }),
            ...(dependency.retention_or_hold_ref === undefined
              ? {}
              : { retention_or_hold_ref: dependency.retention_or_hold_ref }),
            ...(dependency.next_review_at === undefined ? {} : { next_review_at: dependency.next_review_at }),
            identity_digest: dependency.object_identity_digest,
            shared_live_reference_count: liveSharedReferences,
          },
        ));
      }

      const requested = new Set(request.required_locations);
      const unique = new Map<string, PurgeTarget>();
      for (const item of generated.filter((candidate) => requested.has(candidate.location))) {
        const key = `${item.location}\u0000${item.canonical_ref}`;
        const existing = unique.get(key);
        if (existing !== undefined && existing.identity_digest !== item.identity_digest) {
          erasureFail("ERASURE_IDENTITY_CONFLICT", "one erasure target has conflicting exact identities");
        }
        unique.set(key, item);
      }
      for (const location of request.required_locations) {
        if ([...unique.values()].some((candidate) => candidate.location === location)) continue;
        const proofRef = `empty-proof:${location}:${requestDigest}`;
        unique.set(`${location}\u0000${proofRef}`, await target(
          request.exact_subject_refs[0] ?? "missing-subject",
          location,
          proofRef,
          { target_kind: "LOCATION_EMPTY_PROOF" },
        ));
      }
      const targets = [...unique.values()].sort((left, right) =>
        `${left.location}:${left.canonical_ref}`.localeCompare(`${right.location}:${right.canonical_ref}`));
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
