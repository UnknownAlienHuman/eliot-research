import type { D1NavigationStore } from "@eliotr/cloudflare-evidence";
import { evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { buildDocumentMap, buildSourceCard, materializeStructuralNavigation, MAX_CANONICAL_BYTES, NavigationError } from "@eliotr/retrieval";
import type { ScopeSnapshot } from "@eliotr/contracts";
import { NormalizedBundleManifestSchema, type NormalizedBundleManifest } from "@eliotr/contracts";
import { bufferBounded, canonicalNormalizedBundleKey, createR2EvidenceObjectStore, type EvidenceObjectStore } from "@eliotr/platform-cloudflare";
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
 * 2. Every R2 object is resolved through `canonicalNormalizedBundleKey` (residency digest, owner system,
 *    namespace, owner generation, logical id, revision ref all embedded in the key), then verified for
 *    key/ref binding, immutable metadata triple, byte length, SHA-256 digest, media type, ETag presence,
 *    manifest/source-revision agreement and residency+scope identity BEFORE parsing.
 * 3. Authority is re-checked AFTER all R2 reads plus pure derivation and BEFORE any D1 persistence.
 * 4. `D1NavigationStore.putArtifacts` independently re-verifies grant/sources/identity with exact readback
 *    (lost-ACK safe, same-ID divergent bytes rejected). A source mutated between the R2 read and the D1
 *    write is rejected there with zero persisted bytes for that write. R2 verification and D1 persistence
 *    are not one atomic transaction; staleness surfacing between them fails closed instead of persisting.
 *
 * Missing, truncated, altered, foreign or mismatched bindings throw typed fail-closed errors and persist
 * nothing. A source with neither a staged manifest nor staged content (bundle never staged) returns as
 * `metadata_only` so the caller keeps the explicit honest narrower profile; integrity failures of staged
 * bytes never silently downgrade.
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

async function readImmutableTextObject(
  objects: EvidenceObjectStore,
  key: string,
  label: string,
  expectedSha256: string | undefined,
  source: OrientationSource,
): Promise<{ readonly bytes: Uint8Array; readonly text: string } | null> {
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
  if (metadata.source_namespace_id !== undefined && metadata.source_namespace_id !== source.authority.source_namespace_id) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 object belongs to another source namespace`);
  }
  if (metadata.source_owner_generation !== undefined && metadata.source_owner_generation !== source.authority.source_owner_generation) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 object belongs to another owner generation`);
  }
  if (metadata.admission_receipt_ref !== undefined && metadata.admission_receipt_ref !== source.authority.admission_receipt_ref) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 object carries another admission receipt`);
  }
  const contentType = opened.httpMetadata?.contentType;
  if (contentType === undefined || !contentType.toLowerCase().startsWith("text/markdown")) {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} normalized object has an invalid media type`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} R2 bytes are not valid UTF-8`);
  }
  return { bytes, text };
}

async function readVerifiedNormalizedBundle(
  objects: EvidenceObjectStore,
  source: OrientationSource,
): Promise<VerifiedBundle | null> {
  const binding = await bundleIdentity(source);
  const manifestKey = await canonicalNormalizedBundleKey(binding.residencyKeyDigest, binding.identity, "manifest.json");
  const manifestObject = await readImmutableTextObject(objects, manifestKey, "normalized manifest", undefined, source);
  if (manifestObject === null) {
    const contentKey = await canonicalNormalizedBundleKey(binding.residencyKeyDigest, binding.identity, "content.md");
    const direct = await readImmutableTextObject(objects, contentKey, "normalized content", source.authority.content_sha256, source);
    if (direct === null) return null;
    return { markdown: direct.text };
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
  let coordinateMapJson: string | undefined;
  if (manifest.content.mappings !== undefined) {
    if (manifest.content.mappings === manifest.content.markdown) {
      structuralFail("NAVIGATION_ARTIFACT_INVALID", "normalized manifest aliases its coordinate map to content");
    }
    const mappingsKey = await canonicalNormalizedBundleKey(binding.residencyKeyDigest, binding.identity, manifest.content.mappings);
    const mappings = await readImmutableTextObject(objects, mappingsKey, "coordinate map", manifest.content.coordinate_map_digest, source);
    if (mappings === null) {
      structuralFail("NAVIGATION_ARTIFACT_NOT_FOUND", "manifest-referenced coordinate map is not staged");
    }
    coordinateMapJson = mappings.text;
  }
  const contentKey = await canonicalNormalizedBundleKey(binding.residencyKeyDigest, binding.identity, manifest.content.markdown);
  const content = await readImmutableTextObject(objects, contentKey, "normalized content", manifest.content.markdown_sha256, source);
  if (content === null) {
    structuralFail("NAVIGATION_ARTIFACT_NOT_FOUND", "manifest-referenced normalized content is not staged");
  }
  return { markdown: content.text, coordinate_map_json: coordinateMapJson };
}
