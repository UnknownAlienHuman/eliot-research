import type {
  ErasureFence,
  PurgeLocation,
  ErasureDependencyClosure,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  assertErasureInteger,
  assertErasureSha256,
  assertErasureText,
  canonicalErasureJson,
  erasureDigest,
  erasureFail,
  erasureSha256Utf8,
  parseErasureSubject,
  stableErasureId,
  validateErasureRequest,
} from "./canonical.js";
import type {
  ErasureInventoryPort,
  ProjectionInventoryRow,
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
  readonly canonical_projection_generation: unknown;
  readonly copy_layout: unknown;
  readonly canonical_item_key: unknown;
  readonly project_id: unknown;
  readonly project_membership_id: unknown;
  readonly membership_generation: unknown;
  readonly metadata_generation_digest: unknown;
  readonly canonical_body_ref: unknown;
  readonly canonical_body_sha256: unknown;
  readonly managed_instance_id: unknown;
  readonly managed_generation: unknown;
  readonly provider_source: unknown;
  readonly item_key: unknown;
  readonly provider_key: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
  readonly section_content_sha256: unknown;
  readonly document_sha256: unknown;
  readonly document_size_bytes: unknown;
  readonly metadata_json: unknown;
  readonly state: unknown;
  readonly provider_item_id: unknown;
  readonly readback_receipt_json: unknown;
  readonly readback_sha256: unknown;
  readonly managed_item_protocol: unknown;
  readonly target_instance_id: unknown;
  readonly target_generation: unknown;
  readonly target_metadata_generation_digest: unknown;
  readonly work_manifest_sha256: unknown;
  readonly object_residency_key_digest: unknown;
  readonly generation_canonical_projection_generation: unknown;
  readonly canonical_item_count: unknown;
  readonly provider_copy_count: unknown;
  readonly provider_copy_set_digest: unknown;
}

const MAX_CLOSURE_TARGETS = 100_000;
const MAX_COPY_INDEX_PAGES = 256;

function workPrefix(manifestRef: string): string {
  const marker = "/manifests/";
  const index = manifestRef.lastIndexOf(marker);
  if (index < 1) erasureFail("ERASURE_IDENTITY_CONFLICT", "projection manifest ref has no generation prefix");
  return manifestRef.slice(0, index);
}

interface ManagedProviderEffectInventory {
  readonly targets: readonly {
    readonly instance_id: string;
    readonly generation: string;
    readonly key: string;
    readonly provider_item_id: string;
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
      provider_item_id: providerItemId,
      projection_generation: projectionGeneration,
    }));
  }
  return Object.freeze({ targets: Object.freeze(targets), project_copy_generations: projectCopyGenerations });
}

const PROVIDER_METADATA_FIELDS = [
  "canonical_section_id",
  "content_sha256",
  "instruction_taint",
  "projection_generation",
  "source_revision_ref",
] as const;

const PROVIDER_RECEIPT_FIELDS = [
  "chunks_count",
  "content_sha256",
  "file_size",
  "item_key",
  "provider_item_id",
  "provider_key",
  "readback_sha256",
] as const;

interface ProjectCopyIndexItem {
  readonly item_key: unknown;
  readonly canonical_item_key: unknown;
  readonly canonical_section_id: unknown;
  readonly content_sha256: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
  readonly provider_key: unknown;
  readonly canonical_body_ref: unknown;
  readonly canonical_body_sha256: unknown;
}

interface ProjectCopyIndexReceipt {
  readonly protocol: unknown;
  readonly source_revision_ref: unknown;
  readonly complete_residency_key_sha256: unknown;
  readonly canonical_projection_generation: unknown;
  readonly target: unknown;
  readonly project_id: unknown;
  readonly project_membership_id: unknown;
  readonly membership_generation: unknown;
  readonly canonical_source_ref: unknown;
  readonly canonical_source_sha256: unknown;
  readonly provider_copy_count: unknown;
  readonly provider_copy_set_sha256: unknown;
  readonly provider_item_count: unknown;
  readonly provider_item_set_sha256: unknown;
  readonly items: unknown;
}

interface ProjectCopyIndexPage {
  readonly protocol: unknown;
  readonly source_revision_ref: unknown;
  readonly complete_residency_key_sha256: unknown;
  readonly canonical_projection_generation: unknown;
  readonly canonical_source_ref: unknown;
  readonly canonical_source_sha256: unknown;
  readonly target: unknown;
  readonly page_index: unknown;
  readonly cursor_start_project_membership_id: unknown;
  readonly cursor_end_project_membership_id: unknown;
  readonly previous_page_sha256: unknown;
  readonly page_sha256: unknown;
  readonly provider_copy_count: unknown;
  readonly provider_copy_set_sha256: unknown;
  readonly provider_item_count: unknown;
  readonly provider_item_set_sha256: unknown;
  readonly copies: unknown;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", `${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

async function readBoundedR2Body(body: ReadableStream<Uint8Array>, maximumBytes: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        try { await reader.cancel(); } catch { /* preserve the bound failure */ }
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "project-copy index page exceeds the 4 MiB Work bound");
      }
      chunks.push(result.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* stream already released */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function copyItemPayload(item: ProjectCopyIndexItem) {
  return {
    item_key: item.item_key,
    canonical_section_id: item.canonical_section_id,
    content_sha256: item.content_sha256,
    start: item.normalized_start_byte,
    end: item.normalized_end_byte,
  };
}

async function readSourceScopedCopyIndex(
  bucket: R2Bucket | undefined,
  manifestRef: string,
  manifestSha256: string,
  sourceRevisionRef: string,
  residencySha256: string,
  canonicalGeneration: string,
  instanceId: string,
  managedGeneration: string,
  metadataGenerationDigest: string,
  expectedCopyCount: number,
  expectedCopySetSha256: string,
): Promise<ReadonlyMap<string, ProjectCopyIndexItem>> {
  if (bucket === undefined) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source-scoped project-copy Work index is unavailable");
  }
  const sourcePrefix = workPrefix(manifestRef);
  const targetToken = (await stableErasureId("copy-target", instanceId, managedGeneration))
    .slice("copy-target-".length);
  const prefix = `${sourcePrefix}/copy-maps/${targetToken}/${expectedCopySetSha256}/pages/`;
  let listing;
  try { listing = await bucket.list({ prefix, limit: 256 }); }
  catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "source-scoped project-copy page listing failed", true, cause);
  }
  if (!Array.isArray(listing.objects) || listing.truncated || listing.objects.length > MAX_COPY_INDEX_PAGES) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source-scoped project-copy page listing is incomplete or oversized");
  }
  if (expectedCopyCount > 0 && listing.objects.length === 0) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "Core copy receipt has no source-scoped Work index pages");
  }
  const pages = [...listing.objects].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const mappings = new Map<string, ProjectCopyIndexItem>();
  const allCopies: ProjectCopyIndexReceipt[] = [];
  let previousPageSha256: string | null = null;
  let providerItemCount = 0;
  for (const [index, listed] of pages.entries()) {
    const object = await bucket.get(listed.key);
    if (object === null || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > 4 * 1024 * 1024) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source-scoped project-copy page is absent or outside its byte bound");
    }
    const bytes = await readBoundedR2Body(object.body, 4 * 1024 * 1024);
    if (bytes.byteLength !== object.size) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy page streamed size differs from R2 metadata");
    }
    let json: string;
    try { json = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (cause) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy page is not valid UTF-8", false, cause);
    }
    const objectSha256 = await erasureSha256Utf8(json);
    if (object.customMetadata?.eliotr_sha256 !== objectSha256) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy page R2 digest metadata is inconsistent");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(json); }
    catch (cause) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy page JSON is malformed", false, cause);
    }
    const page = objectRecord(parsed, "project-copy page") as unknown as ProjectCopyIndexPage;
    const pageSha256 = assertErasureSha256(page.page_sha256, "project-copy page digest");
    const { page_sha256: _omitted, ...pagePayload } = page as unknown as Record<string, unknown>;
    if (
      page.protocol !== "eliotr.managed-project-copy-map-page.v1" ||
      await erasureDigest(pagePayload) !== pageSha256 ||
      object.customMetadata?.page_sha256 !== pageSha256 ||
      page.page_index !== index ||
      page.previous_page_sha256 !== previousPageSha256 ||
      page.source_revision_ref !== sourceRevisionRef ||
      page.complete_residency_key_sha256 !== residencySha256 ||
      page.canonical_projection_generation !== canonicalGeneration ||
      page.canonical_source_ref !== manifestRef ||
      page.canonical_source_sha256 !== manifestSha256 ||
      !Array.isArray(page.copies)
    ) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy page chain or canonical source binding is inconsistent");
    }
    if (!listed.key.endsWith(`/${String(index).padStart(4, "0")}-${pageSha256}.json`)) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy page key does not bind its ordered page digest");
    }
    const target = objectRecord(page.target, "project-copy target receipt");
    if (
      target.managed_instance_id !== instanceId ||
      target.managed_generation !== managedGeneration ||
      target.metadata_generation_digest !== metadataGenerationDigest
    ) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy page target differs from the immutable Core target pin");
    }
    const copies = page.copies as ProjectCopyIndexReceipt[];
    const pageItemCount = copies.reduce((total, copy) => {
      if (!Array.isArray(copy.items)) erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy receipt items are malformed");
      return total + copy.items.length;
    }, 0);
    const pageCopySetDigest = await erasureDigest(copies.map((copy) => ({
      project_id: copy.project_id,
      project_membership_id: copy.project_membership_id,
      membership_generation: copy.membership_generation,
      provider_copy_set_sha256: copy.provider_copy_set_sha256,
    })));
    const pageItemSetDigest = await erasureDigest(copies.flatMap((copy) =>
      (copy.items as ProjectCopyIndexItem[]).map(copyItemPayload)
    ));
    if (
      page.provider_copy_count !== copies.length ||
      page.provider_item_count !== pageItemCount ||
      page.cursor_start_project_membership_id !== (copies[0]?.project_membership_id ?? null) ||
      page.cursor_end_project_membership_id !== (copies.at(-1)?.project_membership_id ?? null) ||
      page.provider_copy_set_sha256 !== pageCopySetDigest ||
      page.provider_item_set_sha256 !== pageItemSetDigest
    ) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy page counts or set digests are inconsistent");
    }
    for (const copy of copies) {
      const { provider_copy_set_sha256: copyDigest, ...copyPayload } = copy as unknown as Record<string, unknown>;
      const copyTarget = objectRecord(copy.target, "project-copy mapping target receipt");
      if (
        copy.protocol !== "eliotr.managed-project-copy-map.v1" ||
        await erasureDigest(copyPayload) !== copyDigest ||
        copy.source_revision_ref !== sourceRevisionRef ||
        copy.complete_residency_key_sha256 !== residencySha256 ||
        copy.canonical_projection_generation !== canonicalGeneration ||
        copy.canonical_source_ref !== manifestRef ||
        copy.canonical_source_sha256 !== manifestSha256 ||
        copyTarget.managed_instance_id !== instanceId ||
        copyTarget.managed_generation !== managedGeneration ||
        copyTarget.metadata_generation_digest !== metadataGenerationDigest ||
        copy.project_membership_id !== `project:${String(copy.project_id)}:generation:${String(copy.membership_generation)}` ||
        copy.provider_copy_count !== 1 ||
        !Array.isArray(copy.items) ||
        copy.provider_item_count !== copy.items.length
      ) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy mapping receipt is inconsistent");
      }
      for (const rawItem of copy.items as ProjectCopyIndexItem[]) {
        const item = objectRecord(rawItem, "project-copy map item") as unknown as ProjectCopyIndexItem;
        const itemKey = assertErasureText(item.item_key, "project-copy item key", 256);
        const canonicalItemKey = assertErasureIdentifier(item.canonical_item_key, "canonical item key");
        const sectionId = assertErasureIdentifier(item.canonical_section_id, "canonical section ID");
        const contentSha = assertErasureSha256(item.content_sha256, "project-copy content digest");
        const start = assertErasureInteger(item.normalized_start_byte, "project-copy span start", 0, Number.MAX_SAFE_INTEGER);
        const end = assertErasureInteger(item.normalized_end_byte, "project-copy span end", 1, Number.MAX_SAFE_INTEGER);
        const providerKey = assertErasureText(item.provider_key, "project-copy full provider key", 128);
        const bodyRef = assertErasureText(item.canonical_body_ref, "canonical body ref", 2048);
        const bodySha = assertErasureSha256(item.canonical_body_sha256, "canonical body digest");
        if (
          "section_text" in objectRecord(rawItem, "project-copy map item") ||
          itemKey.length === 0 || canonicalItemKey.length === 0 || sectionId.length === 0 || end <= start ||
          !providerKey.startsWith("projection/") || !providerKey.endsWith(`${itemKey}.md`) ||
          !bodyRef.startsWith(sourcePrefix + "/items/") || bodySha !== contentSha
        ) {
          erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy map item is invalid or contains body text");
        }
        const mapKey = `${String(copy.project_membership_id)}\u0000${itemKey}`;
        if (mappings.has(mapKey)) erasureFail("ERASURE_IDENTITY_CONFLICT", "duplicate source-scoped provider mapping");
        mappings.set(mapKey, Object.freeze({
          item_key: itemKey,
          canonical_item_key: canonicalItemKey,
          canonical_section_id: sectionId,
          content_sha256: contentSha,
          normalized_start_byte: start,
          normalized_end_byte: end,
          provider_key: providerKey,
          canonical_body_ref: bodyRef,
          canonical_body_sha256: bodySha,
        }));
      }
      allCopies.push(copy);
    }
    providerItemCount += pageItemCount;
    previousPageSha256 = pageSha256;
  }
  const copySetDigest = await erasureDigest(allCopies.map((copy) => ({
    project_id: copy.project_id,
    project_membership_id: copy.project_membership_id,
    membership_generation: copy.membership_generation,
    provider_copy_set_sha256: copy.provider_copy_set_sha256,
  })));
  if (
    allCopies.length !== expectedCopyCount ||
    copySetDigest !== expectedCopySetSha256 ||
    providerItemCount !== expectedCopyCount * assertErasureInteger(
      allCopies[0]?.provider_item_count,
      "project-copy section count",
      1,
      1024,
    )
  ) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source-scoped copy-map pages do not match the immutable Core copy receipt");
  }
  return mappings;
}

async function exactManagedProviderTargets(
  database: D1Database,
  workBucket: R2Bucket | undefined,
  exactSubjectRef: string,
  sourceRevisionRef: string,
  residencyDigest: string,
  projection: ProjectionInventoryRow,
): Promise<readonly PurgeTarget[]> {
  if (projection.semantic_instance_id === undefined || projection.semantic_generation === undefined) {
    return [];
  }
  const result = await database.prepare(
    "SELECT e.source_revision_ref,e.projection_generation,e.canonical_projection_generation, " +
    "e.copy_layout,e.canonical_item_key,e.project_id,e.project_membership_id,e.membership_generation, " +
    "e.metadata_generation_digest,e.canonical_body_ref,e.canonical_body_sha256, " +
    "e.managed_instance_id,e.managed_generation,e.provider_source,e.provider_key, " +
    "e.normalized_start_byte,e.normalized_end_byte, " +
    "e.section_content_sha256,e.document_sha256,e.document_size_bytes,e.metadata_json,e.state, " +
    "e.provider_item_id,e.readback_receipt_json,e.readback_sha256, " +
    "g.managed_item_protocol,g.managed_target_instance_id AS target_instance_id, " +
    "g.managed_target_generation AS target_generation, " +
    "g.managed_target_metadata_generation_digest AS target_metadata_generation_digest, " +
    "g.work_manifest_sha256,g.object_residency_key_digest, " +
    "g.canonical_projection_generation AS generation_canonical_projection_generation, " +
    "g.canonical_item_count,g.provider_copy_count,g.provider_copy_set_digest " +
    "FROM projection_managed_item_effect e JOIN projection_generation g " +
    "ON g.source_revision_ref=e.source_revision_ref AND g.projection_generation=e.projection_generation " +
    "WHERE e.source_revision_ref=?1 AND e.projection_generation=?2 " +
    `ORDER BY e.desired_index LIMIT ${MAX_CLOSURE_TARGETS + 1}`,
  ).bind(sourceRevisionRef, projection.projection_generation).all<ManagedProviderEffectRow>();
  if (result.success !== true || !Array.isArray(result.results)) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "exact managed provider effect inventory did not read completely", true);
  }
  if (result.results.length > MAX_CLOSURE_TARGETS) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "managed provider effect inventory exceeds the 100000-target limit");
  }
  if (result.results.length === 0) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "managed projection target has no durable exact provider effects");
  }
  const projectCopyRows = result.results.filter((row) => row.copy_layout === "PROJECT_COPY_V1");
  const flatRows = result.results.filter((row) => row.copy_layout === null);
  if (projectCopyRows.length > 0 && flatRows.length > 0) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "one projection execution mixes flat and project-copy layouts");
  }
  let copyIndex = new Map<string, ProjectCopyIndexItem>();
  if (projectCopyRows.length > 0) {
    const firstCopy = projectCopyRows[0];
    if (firstCopy === undefined) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "project-copy inventory is empty");
    const canonicalGeneration = assertErasureIdentifier(
      firstCopy.generation_canonical_projection_generation,
      "Core canonical projection generation",
    );
    const copySetDigest = assertErasureSha256(
      firstCopy.provider_copy_set_digest,
      "Core project-copy set digest",
    );
    const copyCount = assertErasureInteger(firstCopy.provider_copy_count, "Core project-copy count", 1, 256);
    const canonicalItemCount = assertErasureInteger(firstCopy.canonical_item_count, "Core canonical item count", 1, 1024);
    const manifestRef = assertErasureText(projection.work_manifest_ref, "canonical Work manifest ref", 2048);
    const manifestSha256 = assertErasureSha256(firstCopy.work_manifest_sha256, "canonical Work manifest digest");
    const expectedTargetMetadataDigest = assertErasureSha256(
      firstCopy.target_metadata_generation_digest,
      "Core target metadata generation digest",
    );
    if (
      firstCopy.object_residency_key_digest !== residencyDigest ||
      firstCopy.target_instance_id !== projection.semantic_instance_id ||
      firstCopy.target_generation !== projection.semantic_generation ||
      projectCopyRows.length !== result.results.length ||
      result.results.length !== canonicalItemCount * copyCount
    ) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "project-copy effect count or target differs from its Core receipt");
    }
    for (const copyRow of projectCopyRows) {
      if (
        copyRow.generation_canonical_projection_generation !== canonicalGeneration ||
        copyRow.provider_copy_set_digest !== copySetDigest ||
        copyRow.provider_copy_count !== copyCount ||
        copyRow.canonical_item_count !== canonicalItemCount ||
        copyRow.target_metadata_generation_digest !== expectedTargetMetadataDigest ||
        copyRow.object_residency_key_digest !== residencyDigest
      ) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy effects disagree on the canonical/target receipt");
      }
    }
    copyIndex = new Map(await readSourceScopedCopyIndex(
      workBucket,
      manifestRef,
      manifestSha256,
      sourceRevisionRef,
      residencyDigest,
      canonicalGeneration,
      projection.semantic_instance_id,
      projection.semantic_generation,
      expectedTargetMetadataDigest,
      copyCount,
      copySetDigest,
    ));
  }
  const manifestPrefix = projection.work_manifest_ref === undefined
    ? null
    : workPrefix(projection.work_manifest_ref);
  const targets: PurgeTarget[] = [];
  const seenKeys = new Set<string>();
  for (const row of result.results) {
    if (
      row.state !== "READBACK_VERIFIED" ||
      row.provider_item_id === null || row.provider_item_id === undefined ||
      row.readback_receipt_json === null || row.readback_receipt_json === undefined ||
      row.readback_sha256 === null || row.readback_sha256 === undefined
    ) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "managed provider effect has no exact readback identity");
    }
    const rowSource = assertErasureIdentifier(row.source_revision_ref, "provider effect source revision");
    const rowGeneration = assertErasureIdentifier(row.projection_generation, "provider effect execution generation");
    const instanceId = assertErasureIdentifier(row.managed_instance_id, "provider effect target instance");
    const managedGeneration = assertErasureIdentifier(row.managed_generation, "provider effect raw target generation");
    const providerItemId = assertErasureIdentifier(row.provider_item_id, "provider effect item ID");
    const providerKey = assertErasureText(row.provider_key, "persisted full provider key", 128);
    const sectionSha = assertErasureSha256(row.section_content_sha256, "provider effect section digest");
    const documentSha = assertErasureSha256(row.document_sha256, "provider effect document digest");
    const fileSize = assertErasureInteger(row.document_size_bytes, "provider effect document size", 1, 4 * 1024 * 1024);
    const readbackSha = assertErasureSha256(row.readback_sha256, "provider effect readback digest");
    if (
      rowSource !== sourceRevisionRef ||
      rowGeneration !== projection.projection_generation ||
      row.managed_item_protocol !== "eliotr.managed-item-effects.v1" ||
      row.target_instance_id !== projection.semantic_instance_id ||
      row.target_generation !== projection.semantic_generation ||
      instanceId !== projection.semantic_instance_id ||
      managedGeneration !== projection.semantic_generation ||
      row.provider_source !== "builtin" ||
      typeof row.metadata_json !== "string" ||
      typeof row.readback_receipt_json !== "string" ||
      providerKey.length > 128 ||
      seenKeys.has(`${instanceId}\u0000${providerKey}`)
    ) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "managed provider effect is incomplete, ambiguous, or not readback verified");
    }
    seenKeys.add(`${instanceId}\u0000${providerKey}`);
    let metadataValue: unknown;
    let receiptValue: unknown;
    try {
      metadataValue = JSON.parse(row.metadata_json);
      receiptValue = JSON.parse(row.readback_receipt_json);
    } catch (cause) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "managed provider metadata or receipt is malformed", false, cause);
    }
    if (
      typeof metadataValue !== "object" || metadataValue === null || Array.isArray(metadataValue) ||
      typeof receiptValue !== "object" || receiptValue === null || Array.isArray(receiptValue)
    ) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "managed provider metadata or receipt is not an object");
    }
    const metadata = metadataValue as Record<string, unknown>;
    const receipt = receiptValue as Record<string, unknown>;
    const metadataKeys = Object.keys(metadata).sort();
    const receiptKeys = Object.keys(receipt).sort();
    const effectItemKey = assertErasureIdentifier(providerKey.endsWith(".md")
      ? providerKey.slice(providerKey.lastIndexOf("/") + 1, -3)
      : "", "provider effect item key");
    const copyLayout = row.copy_layout;
    const isProjectCopy = copyLayout === "PROJECT_COPY_V1";
    if (
      metadataKeys.length !== PROVIDER_METADATA_FIELDS.length ||
      metadataKeys.some((key, index) => key !== PROVIDER_METADATA_FIELDS[index]) ||
      receiptKeys.length !== PROVIDER_RECEIPT_FIELDS.length ||
      receiptKeys.some((key, index) => key !== PROVIDER_RECEIPT_FIELDS[index]) ||
      metadata.source_revision_ref !== sourceRevisionRef ||
      metadata.content_sha256 !== sectionSha ||
      typeof metadata.canonical_section_id !== "string" ||
      metadata.canonical_section_id.length === 0 ||
      typeof metadata.instruction_taint !== "string" ||
      metadata.projection_generation !== (isProjectCopy ? row.metadata_generation_digest : managedGeneration) ||
      receipt.item_key !== effectItemKey ||
      receipt.provider_item_id !== providerItemId ||
      receipt.provider_key !== providerKey ||
      receipt.content_sha256 !== documentSha ||
      receipt.file_size !== fileSize ||
      receipt.readback_sha256 !== readbackSha ||
      row.readback_receipt_json !== canonicalErasureJson(receipt) ||
      (isProjectCopy && (
        row.canonical_projection_generation === null ||
        row.canonical_item_count === null ||
        row.provider_copy_count === null ||
        row.canonical_body_sha256 !== sectionSha ||
        typeof row.canonical_body_ref !== "string" ||
        manifestPrefix === null ||
        !row.canonical_body_ref.startsWith(manifestPrefix + "/items/") ||
        providerKey.length < 12 ||
        !providerKey.startsWith("projection/")
      )) ||
      (!isProjectCopy && (
        copyLayout !== null ||
        row.canonical_projection_generation !== null ||
        row.canonical_item_key !== null ||
        row.project_id !== null ||
        row.project_membership_id !== null ||
        row.membership_generation !== null ||
        row.metadata_generation_digest !== null ||
        row.canonical_body_ref !== null ||
        row.canonical_body_sha256 !== null
      ))
    ) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "managed provider target differs from its exact five-field metadata/readback");
    }
    assertErasureInteger(receipt.chunks_count, "provider receipt chunk count", 1, 1_000_000);
    if (isProjectCopy) {
      const canonicalItemCount = assertErasureInteger(
        row.canonical_item_count,
        "provider canonical section count",
        1,
        1024,
      );
      const providerCopyCount = assertErasureInteger(
        row.provider_copy_count,
        "provider membership copy count",
        1,
        256,
      );
      const metadataGenerationDigest = assertErasureSha256(
        row.metadata_generation_digest,
        "provider effect metadata generation digest",
      );
      const expectedMetadataDigest = await erasureSha256Utf8(
        `eliotr.project-copy-generation.v1\0${managedGeneration}`,
      );
      if (
        canonicalItemCount < 1 || providerCopyCount < 1 ||
        metadataGenerationDigest !== expectedMetadataDigest ||
        row.project_membership_id !== `project:${String(row.project_id)}:generation:${String(row.membership_generation)}`
      ) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "project-copy target digest or membership identity is inconsistent");
      }
      const canonicalGeneration = assertErasureIdentifier(row.canonical_projection_generation, "canonical projection generation");
      assertErasureIdentifier(row.canonical_item_key, "canonical provider item key");
      assertErasureIdentifier(row.project_id, "provider project ID");
      assertErasureInteger(row.membership_generation, "provider membership generation", 1, Number.MAX_SAFE_INTEGER);
      const mapKey = `${String(row.project_membership_id)}\u0000${effectItemKey}`;
      const mapped = copyIndex.get(mapKey);
      if (
        mapped === undefined ||
        mapped.item_key !== effectItemKey ||
        mapped.canonical_item_key !== row.canonical_item_key ||
        mapped.canonical_section_id !== metadata.canonical_section_id ||
        mapped.content_sha256 !== sectionSha ||
        mapped.normalized_start_byte !== row.normalized_start_byte ||
        mapped.normalized_end_byte !== row.normalized_end_byte ||
        mapped.provider_key !== providerKey ||
        mapped.canonical_body_ref !== row.canonical_body_ref ||
        mapped.canonical_body_sha256 !== row.canonical_body_sha256 ||
        canonicalGeneration !== row.generation_canonical_projection_generation
      ) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "provider effect does not match its source-scoped Work copy-map page");
      }
      copyIndex.delete(mapKey);
    } else if (providerKey !== `${effectItemKey}.md`) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "historical flat provider key differs from its persisted item key");
    }
    const providerRef = `${managedGeneration}:${providerItemId}`;
    targets.push(await target(
      exactSubjectRef,
      "ProviderCopy",
      `ai-search:${instanceId}:${providerKey}`,
      { provider_ref: providerRef },
    ));
  }
  if (copyIndex.size > 0) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source-scoped Work copy-map entries lack durable provider readback effects");
  }
  if (targets.length !== result.results.length) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "managed provider target inventory is incomplete");
  }
  return Object.freeze(targets);
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

function appendVerifiedProviderTarget(
  generated: PurgeTarget[],
  byExactReference: Map<string, PurgeTarget>,
  candidate: PurgeTarget,
): void {
  const reference = canonicalErasureJson({
    exact_subject_ref: candidate.exact_subject_ref,
    location: candidate.location,
    canonical_ref: candidate.canonical_ref,
  });
  const existing = byExactReference.get(reference);
  if (existing !== undefined) {
    if (
      existing.target_id !== candidate.target_id ||
      existing.target_kind !== candidate.target_kind ||
      existing.exact_subject_ref !== candidate.exact_subject_ref ||
      existing.location !== candidate.location ||
      existing.canonical_ref !== candidate.canonical_ref ||
      existing.provider_ref !== candidate.provider_ref ||
      existing.identity_digest !== candidate.identity_digest
    ) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "source-wide and per-projection provider targets disagree on exact identity");
    }
    return;
  }
  ensureClosureCapacity(generated.length, 1, "exact provider erasure targets");
  byExactReference.set(reference, candidate);
  generated.push(candidate);
}

export interface D1ErasureInventoryDependencies {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly work_bucket?: R2Bucket;
  readonly verify_managed_root_dependency_set?: (rootRef: string) => Promise<void>;
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
      const providerTargetsByReference = new Map<string, PurgeTarget>();
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
              dependencies.verify_managed_root_dependency_set,
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
        for (const effect of providerEffects.targets) {
          appendVerifiedProviderTarget(generated, providerTargetsByReference, await target(
            subject,
            "ProviderCopy",
            `ai-search:${effect.instance_id}:${effect.key}`,
            { ...rawPending, provider_ref: `${effect.generation}:${effect.provider_item_id}` },
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
          if (
            request.required_locations.includes("ProviderCopy") &&
            projection.semantic_instance_id !== undefined
          ) {
            if (projection.semantic_generation === undefined) {
              erasureFail("ERASURE_CLOSURE_INCOMPLETE", "active semantic projection lacks an exact provider generation");
            }
            if (!providerEffects.project_copy_generations.has(projection.projection_generation)) {
              erasureFail("ERASURE_CLOSURE_INCOMPLETE", "semantic projection lacks exact durable provider-key/readback rows");
            }
            const providerTargets = await exactManagedProviderTargets(
              dependencies.core_database,
              dependencies.work_bucket,
              subject,
              row.source_revision_ref,
              row.object_residency_key_digest,
              projection,
            );
            for (const providerTarget of providerTargets) {
              appendVerifiedProviderTarget(
                generated,
                providerTargetsByReference,
                raw?.pending === undefined ? providerTarget : applyPending(providerTarget, raw.pending),
              );
            }
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
            dependencies.verify_managed_root_dependency_set,
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
