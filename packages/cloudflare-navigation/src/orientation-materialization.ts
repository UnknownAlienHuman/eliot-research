import type { D1NavigationStore } from "@eliotr/cloudflare-evidence";
import { evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { buildDocumentMap, buildSourceCard, materializeStructuralNavigation, MAX_CANONICAL_BYTES, NavigationError } from "@eliotr/retrieval";
import type { PromotedObjectReadback, ScopeSnapshot } from "@eliotr/contracts";
import { NormalizedBundleManifestSchema, type NormalizedBundleManifest } from "@eliotr/contracts";
import { bufferBounded, canonicalNormalizedBundleKey, createR2EvidenceObjectStore, type EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import { canonicalDigest, objectResidencyKeyDigest, residencyKeyForManifest } from "@eliotr/contracts";
import { loadDurableBundleAdmission, reconcileDurableAdmission, type DurableBundleAdmission, type OrientationSource } from "./orientation-authority.js";
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
  readonly database: D1Database;
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
 * 2. Every source is reconciled against its durable D1 bundle admission receipt
 *    (digest-verified `bundle_receipt_json` re-read by exact source-revision identity):
 *    the mutable `source_revision.normalized_artifact_ref` must equal the durable
 *    canonical manifest ref, and revision/owner/namespace/generation plus the
 *    residency digest must match exactly. Orientation consumes the promotion
 *    readbacks persisted in that receipt; it never trusts the mutable ref alone.
 * 3. The manifest key is the durable canonical manifest ref. Content/map keys are
 *    re-derived per file with their own complete residency digests (distinct
 *    digests, never one content digest for all files) and must equal the durable
 *    per-file canonical keys. Every R2 open then compares the observed ETag and
 *    version, key, size, media type, digest and immutable metadata against the
 *    corresponding durable promotion readback BEFORE parsing. Missing, stale or
 *    substituted receipts, references, ETags, versions, keys or objects throw
 *    typed fail-closed errors and persist nothing.
 * 4. Authority is re-checked AFTER all R2 reads plus pure derivation and BEFORE
 *    any D1 persistence: currentness barriers plus a fresh source-revision and
 *    read-policy row comparison, so an authority/policy/residency/purge mutation
 *    during an actual R2 body read fails closed with zero new artifacts.
 * 5. `D1NavigationStore.putArtifacts` independently re-verifies grant/sources/identity with exact readback
 *    (lost-ACK safe, same-ID divergent bytes rejected). A source mutated between the R2 read and the D1
 *    write is rejected there with zero persisted bytes for that write. R2 verification and D1 persistence
 *    are not one atomic transaction; staleness surfacing between them fails closed instead of persisting.
 *
 * Admission state is explicit: `metadata_only` is returned only when D1
 * authoritatively reports NO_NORMALIZED_BUNDLE_ADMISSION (no committed bundle
 * receipt and no manifest reference). An admitted bundle with a missing bucket,
 * binding, receipt or object is a configuration/integrity failure and never a
 * metadata downgrade. For an admitted bundle the manifest is mandatory:
 * expected-but-missing/corrupt manifest/content/map fails closed with zero new
 * usable artifacts and never becomes a content-only structural success.
 */
export async function materializeStructuralNavigationBatch(
  input: StructuralOrientationInput,
): Promise<StructuralOrientationOutcome> {
  if (input.sources.length > 64) structuralFail("NAVIGATION_LIMIT_EXCEEDED", "structural source set exceeds its ceiling");
  await input.store.requireCurrentScopeSnapshot(input.snapshot);
  const objects = input.evidence_bucket === undefined
    ? null
    : createR2EvidenceObjectStore(input.evidence_bucket);
  const derived: { readonly source: OrientationSource; readonly card: unknown; readonly map: unknown }[] = [];
  const fallback: OrientationSource[] = [];
  for (const source of input.sources) {
    // Prefer the receipt attached at authority load; direct callers fall back
    // to an independent durable re-read here. Either way the mutable revision
    // is reconciled before any R2 effect, and a missing receipt for a claimed
    // manifest reference throws instead of downgrading to metadata.
    const admission = source.bundle_admission
      ?? reconcileDurableAdmission(source.revision, source.authority,
        await loadDurableBundleAdmission(input.database, source.revision.source_revision_ref));
    if (admission === null) {
      fallback.push(source);
      continue;
    }
    if (objects === null) {
      structuralFail("NAVIGATION_STORE_FAILED",
        "admitted bundle has no evidence bucket; refusing a metadata downgrade");
    }
    const bundle = await readVerifiedNormalizedBundle(objects, source, admission);
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
  // Re-verify currentness AND a fresh authority row read after every R2 body
  // read and before any D1 persistence: a mutation smuggled into the R2 window
  // (authority, policy, residency, purge, snapshot) fails closed here.
  await input.store.requireCurrentScopeSnapshot(input.snapshot);
  for (const entry of derived) {
    await verifyAuthorityUnchanged(input.database, entry.source);
  }
  const puts = derived.flatMap((entry) => ([
    { kind: "SOURCE_CARD" as const, artifact: entry.card },
    { kind: "DOCUMENT_MAP" as const, artifact: entry.map },
  ]));
  for (let start = 0; start < puts.length; start += 64) {
    await input.store.putArtifacts(puts.slice(start, start + 64));
  }
  return { structural: derived.map((entry) => entry.source), metadata_only: fallback };
}

interface AuthorityRow {
  source_revision_ref: string;
  source_id: string;
  source_owner_generation: string;
  content_sha256: string;
  object_residency_key_digest: string;
  normalized_artifact_ref: string | null;
  purge_state: string;
}

async function verifyAuthorityUnchanged(database: D1Database, source: OrientationSource): Promise<void> {
  const row = await database.prepare(
    "SELECT source_revision_ref, source_id, source_owner_generation, content_sha256, " +
    "object_residency_key_digest, normalized_artifact_ref, purge_state " +
    "FROM source_revision WHERE source_revision_ref = ?1 LIMIT 1",
  ).bind(source.revision.source_revision_ref).first<AuthorityRow>();
  if (row === null
    || row.source_revision_ref !== source.authority.source_revision_ref
    || row.source_id !== source.authority.source_id
    || row.source_owner_generation !== source.authority.source_owner_generation
    || row.content_sha256 !== source.authority.content_sha256
    || row.object_residency_key_digest !== source.authority.object_residency_key_digest
    || row.normalized_artifact_ref !== source.authority.normalized_artifact_ref
    || row.purge_state !== "LIVE") {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "source authority changed during the admitted R2 read");
  }
  const admission = source.bundle_admission
    ?? await loadDurableBundleAdmission(database, source.revision.source_revision_ref);
  if (reconcileDurableAdmission(source.revision, source.authority, admission) === null) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "bundle admission changed during the admitted R2 read");
  }
  const policies = await database.prepare(
    "SELECT disclosure_ceiling, allowed_use_json, state FROM scope_read_policy WHERE source_namespace_id = ?1 LIMIT 65",
  ).bind(source.authority.source_namespace_id).all<{ disclosure_ceiling: string; allowed_use_json: string; state: string }>();
  if (!policies.success || !Array.isArray(policies.results) || !policies.results.some((policy) =>
    policy.state === "ACTIVE"
    && policy.disclosure_ceiling === source.policy.disclosure_ceiling
    && policy.allowed_use_json === source.policy.allowed_use_json)) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "read policy changed during the admitted R2 read");
  }
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
  expected: PromotedObjectReadback,
  source: OrientationSource,
  logicalPath: string,
): Promise<{ readonly bytes: Uint8Array; readonly text: string; readonly sha256: string }> {
  if (key !== expected.canonical_key) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} key differs from its durable promotion readback`);
  }
  let opened;
  try {
    opened = await objects.open(key);
  } catch {
    structuralFail("NAVIGATION_STORE_FAILED", `${label} R2 read is unavailable`);
  }
  // An admitted bundle never degrades to metadata: a missing object is an
  // integrity failure, not an absent admission.
  if (opened === null) {
    structuralFail("NAVIGATION_ARTIFACT_NOT_FOUND", `${label} admitted object is absent from R2`);
  }
  if (typeof opened.etag !== "string" || opened.etag.length === 0 || /[\u0000-\u001f\u007f]/u.test(opened.etag)) {
    try { await opened.body.cancel(); } catch { /* preserve the authority failure */ }
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} R2 ETag binding is missing`);
  }
  // Exact readback-identity reconciliation against the durable promotion
  // receipt: a substituted object (same bytes, fresh write) still fails here
  // because its ETag/version differs from the admitted promotion readback.
  if (opened.etag !== expected.etag) {
    try { await opened.body.cancel(); } catch { /* preserve the authority failure */ }
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 ETag differs from its durable promotion readback`);
  }
  const observedVersion = (opened as unknown as { readonly version?: unknown }).version;
  if (expected.version !== undefined && observedVersion !== expected.version) {
    try { await opened.body.cancel(); } catch { /* preserve the authority failure */ }
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 version differs from its durable promotion readback`);
  }
  if (observedVersion !== undefined
    && (typeof observedVersion !== "string" || observedVersion.length === 0
      || /[\u0000-\u001f\u007f]/u.test(observedVersion))) {
    try { await opened.body.cancel(); } catch { /* preserve the authority failure */ }
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} R2 version binding is malformed`);
  }
  if (!Number.isSafeInteger(opened.size) || opened.size < 1 || opened.size > MAX_CANONICAL_BYTES) {
    try { await opened.body.cancel(); } catch { /* preserve the authority failure */ }
    structuralFail("NAVIGATION_LIMIT_EXCEEDED", `${label} R2 size escapes the canonical byte envelope`);
  }
  if (opened.size !== expected.size_bytes) {
    try { await opened.body.cancel(); } catch { /* preserve the authority failure */ }
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 size differs from its durable promotion readback`);
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
  if (observedSha !== expected.sha256) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} R2 bytes differ from the durable promotion readback`);
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
  // The durable promotion readback carries the readback identity observed at
  // promotion time; unknown load-bearing fields already failed closed at the
  // strict receipt decode. Version shape was verified above.
  const contentType = opened.httpMetadata?.contentType;
  if (!mediaTypeAccepted(contentType, logicalPath)) {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", `${label} normalized object has an invalid media type`);
  }
  // Durable media-type equality on the type base: the promotion receipt stores
  // the canonical full type (with charset), R2 returns it verbatim.
  const observedBase = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const expectedBase = expected.content_type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (observedBase.length === 0 || observedBase !== expectedBase) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", `${label} media type differs from its durable promotion readback`);
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
  admission: DurableBundleAdmission,
): Promise<VerifiedBundle> {
  const binding = await bundleIdentity(source);
  // Canonical promotion stores per-file residency digests, so manifest/content/map live
  // under distinct keys. The exact manifest key is the durable canonical manifest ref
  // (reconciled against the mutable revision at authority load, never re-derived from
  // the content digest, never scanned/listed, never newest-wins). Every file is then
  // opened against its durable per-file promotion readback.
  const receipt = admission.receipt;
  if (receipt.promoted_objects === undefined || receipt.promoted_objects.length === 0) {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", "admitted bundle carries no durable promotion readbacks");
  }
  const readbacks = new Map(receipt.promoted_objects.map((entry) => [entry.logical_path, entry]));
  const manifestEntry = readbacks.get("manifest.json");
  if (manifestEntry === undefined) {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", "durable promotion readbacks omit the admitted manifest");
  }
  const manifestKey = source.authority.normalized_artifact_ref;
  if (manifestKey !== receipt.normalized_artifact_ref || manifestKey !== manifestEntry.canonical_key) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "admitted manifest reference differs from its durable receipt");
  }
  if (!manifestKey.endsWith("/manifest.json")) {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", "admitted manifest reference is not a canonical bundle key");
  }
  const manifestObject = await readImmutableTextObject(objects, manifestKey, "normalized manifest", manifestEntry, source, "manifest.json");
  let manifest: NormalizedBundleManifest;
  try {
    manifest = NormalizedBundleManifestSchema.parse(JSON.parse(manifestObject.text));
  } catch {
    structuralFail("NAVIGATION_ARTIFACT_INVALID", "normalized manifest fails strict validation");
  }
  // The durable receipt binds the canonical manifest object digest (the
  // admission identity), while the per-file entry binds the exact transported
  // bytes (already verified on open). Both must hold: a well-formed manifest
  // under the right key still fails when its admitted object digest differs.
  if (await canonicalDigest(manifest) !== receipt.manifest_sha256) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "admitted manifest object differs from the durable receipt digest");
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
    const mapEntry = readbacks.get(manifest.content.mappings);
    if (mapEntry === undefined) {
      structuralFail("NAVIGATION_SOURCE_MISMATCH", "coordinate map has no durable promotion readback");
    }
    if (mapEntry.sha256 !== manifest.content.coordinate_map_digest) {
      structuralFail("NAVIGATION_SOURCE_MISMATCH", "coordinate map digest differs from its durable promotion readback");
    }
    const mapResidencyDigest = await objectResidencyKeyDigest({
      ...baseResidency,
      content_digest: { algorithm: "sha256", digest: manifest.content.coordinate_map_digest },
    });
    if (mapResidencyDigest !== mapEntry.residency_key_digest) {
      structuralFail("NAVIGATION_SOURCE_MISMATCH", "coordinate map residency differs from its durable promotion readback");
    }
    const mappingsKey = await canonicalNormalizedBundleKey(mapResidencyDigest, binding.identity, manifest.content.mappings);
    const mappings = await readImmutableTextObject(objects, mappingsKey, "coordinate map", mapEntry, source, manifest.content.mappings);
    coordinateMapJson = mappings.text;
  }
  const contentEntry = readbacks.get(manifest.content.markdown);
  if (contentEntry === undefined) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "normalized content has no durable promotion readback");
  }
  if (manifest.content.markdown_sha256 !== contentEntry.sha256
    || manifest.content.markdown_sha256 !== source.authority.content_sha256) {
    structuralFail("NAVIGATION_SOURCE_MISMATCH", "normalized content digest differs from its durable promotion readback");
  }
  const contentKey = await canonicalNormalizedBundleKey(contentResidencyDigest, binding.identity, manifest.content.markdown);
  const content = await readImmutableTextObject(objects, contentKey, "normalized content", contentEntry, source, manifest.content.markdown);
  return { markdown: content.text, coordinate_map_json: coordinateMapJson };
}
