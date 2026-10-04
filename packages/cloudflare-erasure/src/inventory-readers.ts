import type { PurgeLocation } from "@eliotr/contracts";
import { assertErasureIdentifier, assertErasureSha256, assertErasureText, erasureFail } from "./canonical.js";
import type { ProjectionInventoryRow, ProjectionItemInventoryRow, RegisteredDependencyRow, SourceRevisionInventoryRow } from "./types.js";

interface RevisionRow {
  readonly source_revision_ref: unknown;
  readonly source_id: unknown;
  readonly source_owner_generation: unknown;
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
  if (result.success !== true || !Array.isArray(result.results)) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} did not return a complete successful result`, true);
  }
  const rows = result.results;
  if (rows.length > INVENTORY_ROW_LIMIT) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", `${label} exceeds the bounded ${INVENTORY_ROW_LIMIT}-row inventory`);
  }
  return rows;
}

export function ensureClosureCapacity(current: number, additional: number, label: string): void {
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
    source_owner_generation: assertErasureIdentifier(row.source_owner_generation, "source owner generation"),
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

export async function revisionRows(database: D1Database, sourceId: string): Promise<readonly SourceRevisionInventoryRow[]> {
  const result = await database.prepare(
    "SELECT source_revision_ref,source_id,source_owner_generation,original_r2_key,normalized_artifact_ref," +
    "content_sha256,object_residency_key_digest,purge_state FROM source_revision " +
    `WHERE source_id=?1 ORDER BY source_revision_ref LIMIT ${INVENTORY_FETCH_LIMIT}`,
  ).bind(sourceId).all<RevisionRow>();
  return boundedRows(result, "source revision inventory").map(decodeRevision);
}

export async function oneRevision(database: D1Database, revisionRef: string): Promise<SourceRevisionInventoryRow> {
  const row = await database.prepare(
    "SELECT source_revision_ref,source_id,source_owner_generation,original_r2_key,normalized_artifact_ref," +
    "content_sha256,object_residency_key_digest,purge_state FROM source_revision " +
    "WHERE source_revision_ref=?1 LIMIT 1",
  ).bind(revisionRef).first<RevisionRow>();
  if (row === null) erasureFail("ERASURE_INPUT_INVALID", `source revision ${revisionRef} does not exist`);
  return decodeRevision(row);
}

export async function sourceOwnerGeneration(database: D1Database, sourceId: string): Promise<string> {
  const result = await database.prepare(
    "SELECT source_id,source_owner_generation FROM source WHERE source_id=?1 LIMIT 2",
  ).bind(sourceId).all<{ readonly source_id: unknown; readonly source_owner_generation: unknown }>();
  const rows = boundedRows(result, "backup source root inventory");
  if (rows.length !== 1 || rows[0]?.source_id !== sourceId) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source backup root is absent or ambiguous");
  }
  return assertErasureIdentifier(rows[0]?.source_owner_generation, "source owner generation");
}

export async function projections(database: D1Database, revisionRef: string): Promise<readonly ProjectionInventoryRow[]> {
  const result = await database.prepare(
    "SELECT source_revision_ref,projection_generation,work_manifest_ref,semantic_instance_id," +
    "semantic_generation,state FROM projection_generation WHERE source_revision_ref=?1 " +
    `ORDER BY projection_generation LIMIT ${INVENTORY_FETCH_LIMIT}`,
  ).bind(revisionRef).all<ProjectionRow>();
  return boundedRows(result, "projection inventory").map(decodeProjection);
}

export async function items(database: D1Database, revisionRef: string, generation: string): Promise<readonly ProjectionItemInventoryRow[]> {
  const result = await database.prepare(
    "SELECT item_key,projection_generation FROM projection_item WHERE source_revision_ref=?1 " +
    `AND projection_generation=?2 ORDER BY item_key LIMIT ${INVENTORY_FETCH_LIMIT}`,
  ).bind(revisionRef, generation).all<ItemRow>();
  return boundedRows(result, "projection item inventory").map(decodeItem);
}

export async function registered(
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

export async function registeredSharedCount(
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
