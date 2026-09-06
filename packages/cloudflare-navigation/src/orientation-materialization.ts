import type { D1NavigationStore } from "@eliotr/cloudflare-evidence";
import { evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { buildDocumentMap, buildSourceCard, materializeStructuralNavigation, MAX_CANONICAL_BYTES, NavigationError } from "@eliotr/retrieval";
import type { ScopeSnapshot } from "@eliotr/contracts";
import { NormalizedBundleManifestSchema, type NormalizedBundleManifest } from "@eliotr/contracts";
import { bufferBounded, canonicalNormalizedBundleKey, createR2EvidenceObjectStore, objectResidencyKeyDigest, residencyKeyForManifest, type EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { OrientationSource } from "./orientation-authority.js";
import { ORIENTATION_PROFILE } from "./orientation-input.js";

/** This fallback asserts only admitted metadata. It does not invent summaries or structural coordinates. */
export async function materializeMetadataNavigation(store: D1NavigationStore, snapshot: ScopeSnapshot,
  sources: readonly OrientationSource[]): Promise<void> {
  const refs = sources.map((source) => source.revision.source_revision_ref);
  const existingCards = await store.getSourceCards(refs);
  const existingMaps = await store.getDocumentMaps(refs);
  const cardSources = new Set(existingCards.map((card) => (card as { source_revision_ref: string }).source_revision_ref));
  const mapSources = new Set(existingMaps.map((map) => (map as { source_revision_ref: string }).source_revision_ref));
  const batch: Parameters<D1NavigationStore["putArtifacts"]>[0][number][] = [];
  for (const source of sources) {
    if (!cardSources.has(source.revision.source_revision_ref)) {
      batch.push({ kind: "SOURCE_CARD", artifact: await buildSourceCard({ source_revision: source.revision,
        generator_generation: ORIENTATION_PROFILE, created_at: snapshot.created_at,
        draft: { title: source.title, authors: [], language: "und", source_kind: source.authority.source_class,
          document_role: "unclassified", authority_hint: "metadata_only", abstract: "", main_topics: [],
          controlled_vocabulary: [], outline: [], important_section_refs: [], likely_uses: ["source_selection"] } }) });
    }
    if (!mapSources.has(source.revision.source_revision_ref)) {
      batch.push({ kind: "DOCUMENT_MAP", artifact: await buildDocumentMap({ source_revision: source.revision,
        generator_generation: ORIENTATION_PROFILE, created_at: snapshot.created_at,
        fragments: [{ fragment_id: "metadata-only", source_revision_ref: source.revision.source_revision_ref,
          unresolved_structure: ["STRUCTURE_NOT_MATERIALIZED", "METADATA_ONLY_NO_SOURCE_SPANS"] }] }) });
    }
  }
  for (let start = 0; start < batch.length; start += 64) await store.putArtifacts(batch.slice(start, start + 64));
}

function structuralFail(code: NavigationError["code"], message: string): never {
  throw new NavigationError(code, message);
}

export interface StructuralOrientationInput {
  readonly store: D1NavigationStore;
  readonly snapshot: ScopeSnapshot;
  readonly sources: readonly OrientationSource[];
  readonly evidence_bucket?: R2Bucket | undefined;
  readonly created_at?: string | undefined;
}

export interface StructuralOrientationOutcome {
  /** Sources with verified structural artifacts persisted through the real D1NavigationStore. */
  readonly structural: readonly OrientationSource[];
  /** Sources with no staged bundle; the caller keeps them on the honest metadata-only profile. */
  readonly metadata_only: readonly OrientationSource[];
}

interface VerifiedBundle {
  readonly markdown: string;
  readonly coordinate_map_json?: string | undefined;
}

/**
 * N1 supported structural contour: admitted SourceRevision/manifest + current authority -> R2 -> pure -> D1.
 *
 * Authority invariant (documented, no cross-system atomicity claimed):
 * 1. `store.requireCurrentScopeSnapshot` binds principal/owner generation, residency, ScopeSnapshot
 *    identity/revision/currentness, grant, read policy, policy generation/authority ref, deployment
 *    generation and global/scope purge fences BEFORE any R2 read.
 * 2. The manifest key is the D1 admission receipt
 *    (`source_revision.normalized_artifact_ref === promotion.canonical_manifest_ref`).
 *    Content/map keys are re-derived per file with their own complete residency digests
 *    (three distinct digests, never one content digest for all files). Every R2 object is
 *    then verified for key/ref binding, mandatory immutable metadata (namespace, owner
 *    generation, admission receipt, digest, size, object identity), byte length, SHA-256
 *    digest, path-specific media type (Markdown content, JSON manifest/map with charset
 *    normalization), ETag/readback identity, manifest/source-revision agreement and
 *    residency_and_disclosure binding to current D1 authority (recomputed digests) BEFORE parsing.
 * 3. Authority is re-checked AFTER all R2 reads plus pure derivation and BEFORE any D1 persistence.
 * 4. `D1NavigationStore.putArtifacts` independently re-verifies grant/sources/identity with exact readback
 *    (lost-ACK safe, same-ID divergent bytes rejected). A source mutated between the R2 read and the D1
 *    write is rejected there with zero persisted bytes for that write. R2 verification and D1 persistence
 *    are not one atomic transaction; staleness surfacing between them fails closed instead of persisting.
 *
 * Missing, truncated, altered, foreign or mismatched bindings throw typed fail-closed errors and persist
 * nothing. For an admitted bundle the manifest is mandatory: expected-but-missing/corrupt
 * manifest/content/map fails closed with zero new usable artifacts and never becomes a
 * content-only structural success. `metadata_only` is returned only when authoritative D1
 * proves no normalized-bundle admission exists at all (empty manifest reference) or when no
 * evidence bucket is configured; integrity failures never silently downgrade.
 */
export async function materializeStructuralNavigationBatch(
  input: StructuralOrientationInput,
): Promise<StructuralOrientationOutcome> {
  const bucket = input.evidence_bucket;
  if (bucket === undefined) return { structural: [], metadata_only: input.sources };
  if (input.sources.length > 64) structuralFail("NAVIGATION_LIMIT_EXCEEDED", "structural source set exceeds its ceiling");
  await input.store.requireCurrentScopeSnapshot(input.snapshot);
  const objects = createR2EvidenceObjectStore(bucket);
  const derived: { readonly source: OrientationSource; readonly card: unknown; readonly map: unknown }[] = [];
  const fallback: OrientationSource[] = [];
  for (const source of input.sources) {
    const bundle = await readVerifiedNormalizedBundle(objects, source);
    if (bundle === null) {
      fallback.push(source);
      continue;
    }
    const createdAt = input.created_at ?? input.snapshot.created_at;
    const result = await materializeStructuralNavigation({
      source_revision: source.revision,
      scope_snapshot: input.snapshot,
      normalized_markdown: bundle.markdown,
      ...(bundle.coordinate_map_json === undefined ? {} : { coordinate_map_json: bundle.coordinate_map_json }),
      generator_generation: ORIENTATION_PROFILE,
      created_at: createdAt,
    });
    derived.push({ source, card: result.sourceCard, map: result.documentMap });
  }
  if (derived.length === 0) return { structural: [], metadata_only: fallback };
  await input.store.requireCurrentScopeSnapshot(input.snapshot);
  const puts = derived.flatMap((entry) => ([
    { kind: "SOURCE_CARD" as const, artifact: entry.card },
    { kind: "DOCUMENT_MAP" as const, artifact: entry.map },
  ]));
  for (let start = 0; start < puts.length; start += 64) {
    await input.store.putArtifacts(puts.slice(start, start + 64));
  }
  return { structural: derived.map((entry) => entry.source), metadata_only: fallback };
}

async function bundleIdentity(source: OrientationSource): Promise<{
  readonly residencyKeyDigest: string;
  readonly identity: {
    readonly owner_system_id: string;
    readonly source_namespace_id: string;
    readonly source_owner_generation: string;
    readonly source_logical_id: string;
    readonly source_revision_ref: string;
  };
}> {
  const authority = source.authority;
  const revision = source.revision;
  if (authority.source_revision_ref !== revision.source_revision_ref
    || authority.source_owner_generation !== revision.source_owner_generation
    || authority.content_sha256 !== revision.content_sha256
    || authority.source_id !== revision.source_id
    || authority.source_namespace_id !== revision.source_namespace_id
    || authority.owner_system_id !== revision.source_owner_system_id) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "orientation source authority disagrees with the admitted revision");
  }
  return {
    residencyKeyDigest: authority.object_residency_key_digest,
    identity: {
      owner_system_id: authority.owner_system_id,
      source_namespace_id: authority.source_namespace_id,
      source_owner_generation: authority.source_owner_generation,
      source_logical_id: authority.source_id,
      source_revision_ref: authority.source_revision_ref,
    },
  };
}

function expectedMediaBase(logicalPath: string): string {
  if (logicalPath.endsWith(".md")) return "text/markdown";
  if (logicalPath.endsWith(".json")) return "application/json";
  if (logicalPath.endsWith(".sha256")) return "text/plain";
  return "application/octet-stream";
}

function mediaTypeAccepted(actual: string | undefined, logicalPath: string): boolean {
  if (actual === undefined) return false;
  const segments = actual.split(";");
  const base = segments[0]?.trim().toLowerCase();
  if (base !== expectedMediaBase(logicalPath)) return false;
  if (segments.length === 1) return true;
  if (segments.length === 2) {
    const param = segments[1]?.trim().toLowerCase();
    return param === "charset=utf-8" || param === "charset=utf8" || param === "charset=\"utf-8\"";
  }
  return false;
}

async function readImmutableTextObject(
  objects: EvidenceObjectStore,
  key: string,
  label: string,
  expectedSha256: string | undefined,
  source: OrientationSource,
  logicalPath: string,
): Promise<{ readonly bytes: Uint8Array; readonly text: string; readonly sha256: string } | null> {
  let opened;
  try {
    opened = await objects.open(key);
  } catch {
    structuralFail("NAVIGATION_STORE_FAILED", `${label} R2 read is unavailable`);
  }
  if (opened === null) return null;
  if (typeof opened.etag !== "string" || opened.etag.length === 0 || /[\u0000-\u001f\u007f]/u.test(opened.etag)) {
    try { await opened.body.cancel(); } catch { /* preserve the authority failure */ }
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} R2 ETag binding is missing`);
  }
  if (!Number.isSafeInteger(opened.size) || opened.size < 1 || opened.size > MAX_CANONICAL_BYTES) {
    try { await opened.body.cancel(); } catch { /* preserve the authority failure */ }
    structuralFail("NAVIGATION_LIMIT_EXCEEDED", `${label} R2 size escapes the canonical byte envelope`);
  }
  const metadata = opened.customMetadata ?? {};
  let bytes: Uint8Array;
  try {
    bytes = await bufferBounded(opened.body, MAX_CANONICAL_BYTES);
  } catch {
    structuralFail("NAVIGATION_LIMIT_EXCEEDED", `${label} R2 body escapes the canonical byte envelope`);
  }
  if (bytes.byteLength !== opened.size) {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} R2 streamed length differs from its stored size`);
  }
  const observedSha = await evidenceSha256Bytes(bytes);
  if (expectedSha256 !== undefined && observedSha !== expectedSha256) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 bytes differ from the admitted digest`);
  }
  if (metadata.eliotr_immutable !== "true"
    || metadata.eliotr_sha256 !== observedSha
    || metadata.eliotr_size_bytes !== String(opened.size)) {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} R2 immutable authority metadata mismatch`);
  }
  if (metadata.source_namespace_id !== source.authority.source_namespace_id) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 object belongs to another source namespace`);
  }
  if (metadata.source_owner_generation !== source.authority.source_owner_generation) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 object belongs to another owner generation`);
  }
  if (metadata.admission_receipt_ref !== source.authority.admission_receipt_ref) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 object carries another admission receipt`);
  }
  // Production R2 cannot precompute an ETag before the immutable write. The promotion
  // receipt persists the actual readback ETag; here we validate the actual readback
  // identity (non-empty ETag, exact size/digest/metadata binding) rather than non-empty alone.
  const version = (opened as unknown as { readonly version?: unknown }).version;
  if (typeof version === "string" && version.length > 0 && /[\u0000-\u001f\u007f]/u.test(version)) {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} R2 version binding is malformed`);
  }
  const contentType = opened.httpMetadata?.contentType;
  if (!mediaTypeAccepted(contentType, logicalPath)) {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} normalized object has an invalid media type`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} R2 bytes are not valid UTF-8`);
  }
  return { bytes, text, sha256: observedSha };
}

async function readVerifiedNormalizedBundle(
  objects: EvidenceObjectStore,
  source: OrientationSource,
): Promise<VerifiedBundle | null> {
  const binding = await bundleIdentity(source);
  // Canonical promotion stores per-file residency digests, so manifest/content/map live
  // under three distinct keys. The exact manifest key is the D1 admission receipt
  // (source_revision.normalized_artifact_ref === promotion.canonical_manifest_ref).
  // Never re-derive it from the content digest, never scan/list R2, never choose newest.
  const manifestKey = source.authority.normalized_artifact_ref;
  if (typeof manifestKey !== "string" || manifestKey.length === 0) {
    return null;
  }
  if (!manifestKey.endsWith("/manifest.json")) {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", "admitted manifest reference is not a canonical bundle key");
  }
  const manifestObject = await readImmutableTextObject(objects, manifestKey, "normalized manifest", undefined, source, "manifest.json");
  if (manifestObject === null) {
    structuralFail("NAVIGATION_ARTIFACT_NOT_FOUND", "admitted normalized manifest is not staged");
  }
  let manifest: NormalizedBundleManifest;
  try {
    manifest = NormalizedBundleManifestSchema.parse(JSON.parse(manifestObject.text));
  } catch {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", "normalized manifest fails strict validation");
  }
  if (manifest.origin.owner_system_id !== source.authority.owner_system_id
    || manifest.origin.source_namespace_id !== source.authority.source_namespace_id
    || manifest.origin.source_owner_generation !== source.authority.source_owner_generation
    || manifest.origin.source_revision_ref !== source.authority.source_revision_ref) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "normalized manifest binds another admitted source");
  }
  if (manifest.source.logical_id !== source.authority.source_id) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "normalized manifest binds another source identity");
  }
  if (manifest.content.markdown !== "content.md") {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", "normalized manifest names an unexpected content layout");
  }
  if (manifest.content.markdown_sha256 !== source.authority.content_sha256) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "normalized manifest disagrees with the admitted content digest");
  }
  if (manifest.residency_and_disclosure.disclosure_ceiling !== source.authority.disclosure_ceiling) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "normalized manifest disclosure disagrees with current D1 authority");
  }
  const manifestUses = [...manifest.residency_and_disclosure.allowed_use].sort();
  const authorityUses = [...source.authority.allowed_use].sort();
  if (JSON.stringify(manifestUses) !== JSON.stringify(authorityUses)) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "normalized manifest allowed use disagrees with current D1 authority");
  }
  if (manifest.residency_and_disclosure.disclosure_ceiling !== source.policy.disclosure_ceiling) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "normalized manifest disclosure disagrees with the current read policy");
  }
  const baseResidency = residencyKeyForManifest(manifest);
  const contentResidencyDigest = await objectResidencyKeyDigest(baseResidency);
  if (contentResidencyDigest !== source.authority.object_residency_key_digest) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "manifest residency does not recompute to the admitted residency digest");
  }
  const manifestResidencyDigest = await objectResidencyKeyDigest({
    ...baseResidency,
    content_digest: { algorithm: "sha256", digest: manifestObject.sha256 },
  });
  const expectedManifestKey = await canonicalNormalizedBundleKey(manifestResidencyDigest, binding.identity, "manifest.json");
  if (expectedManifestKey !== manifestKey) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "admitted manifest key does not match its recomputed residency digest");
  }
  let coordinateMapJson: string | undefined;
  if (manifest.content.mappings !== undefined) {
    if (manifest.content.mappings === manifest.content.markdown) {
      structuralFail("NAVIGATION_ARTIFACT_INVALID", "normalized manifest aliases its coordinate map to content");
    }
    if (manifest.content.coordinate_map_digest === undefined) {
      structuralFail("NAVIGATION_ARTIFACT_INVALID", "manifest-referenced coordinate map has no digest binding");
    }
    const mapResidencyDigest = await objectResidencyKeyDigest({
      ...baseResidency,
      content_digest: { algorithm: "sha256", digest: manifest.content.coordinate_map_digest },
    });
    const mappingsKey = await canonicalNormalizedBundleKey(mapResidencyDigest, binding.identity, manifest.content.mappings);
    const mappings = await readImmutableTextObject(objects, mappingsKey, "coordinate map", manifest.content.coordinate_map_digest, source, manifest.content.mappings);
    if (mappings === null) {
      structuralFail("NAVIGATION_ARTIFACT_NOT_FOUND", "manifest-referenced coordinate map is not staged");
    }
    coordinateMapJson = mappings.text;
  }
  const contentKey = await canonicalNormalizedBundleKey(contentResidencyDigest, binding.identity, manifest.content.markdown);
  const content = await readImmutableTextObject(objects, contentKey, "normalized content", manifest.content.markdown_sha256, source, manifest.content.markdown);
  if (content === null) {
    structuralFail("NAVIGATION_ARTIFACT_NOT_FOUND", "manifest-referenced normalized content is not staged");
  }
  return { markdown: content.text, coordinate_map_json: coordinateMapJson };
}
