import {
  LocatorCandidateSchema,
  ScopeSnapshotSchema,
  VersionedRefSchema,
  type EvidenceHandle,
  type LocatorCandidate,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  assertEvidenceIdentifier,
  assertEvidenceInteger,
  assertEvidenceSha256,
  canonicalEvidenceJson,
  evidenceRefKey,
  evidenceSha256Bytes,
  evidenceUtf8Bytes,
  exactEvidenceRef,
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  EvidenceRuntimeError,
  loadEvidenceHandle,
  type EvidenceAccessContext,
  type NavigationReadAuthority,
  type ScopeAuthorization,
  type EvidenceSourceAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  ArtifactDraftReadError,
  readArtifactDraftReauthorizedInternal,
  type ArtifactDraftReauthorizedCoreRead,
  type ArtifactDraftReauthorizationSectionReadInput,
} from "./artifact-draft-reader-core.js";
import type { ArtifactDraftSectionCitationsRead } from "./artifact-draft-citations-reader.js";
import type { ArtifactDraftSemanticAudit } from "./artifact-draft-verification.js";

export const ARTIFACT_DRAFT_CITATIONS_REAUTHORIZATION_PROTOCOL =
  "eliotr.artifact-draft-citations-reauthorization.v1" as const;

export interface ArtifactDraftCitationReauthorizationInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly access: EvidenceAccessContext;
  readonly current_navigation: NavigationReadAuthority;
  readonly current_authorization: ScopeAuthorization;
  readonly deployment_generation: string;
  readonly now?: () => number;
}

export interface ReauthorizedCitationEvidence {
  readonly original_handle_ref: VersionedRef;
  readonly handle_ref: VersionedRef;
  readonly excerpt_sha256: string;
}

interface ReauthorizedCitationsCommon {
  readonly protocol: typeof ARTIFACT_DRAFT_CITATIONS_REAUTHORIZATION_PROTOCOL;
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly authorization_scope_snapshot_ref: VersionedRef;
  readonly authorization: ScopeAuthorization;
  readonly deployment_generation: string;
  readonly verification_receipt_ref: string;
  readonly cited_evidence: readonly ReauthorizedCitationEvidence[];
}

export type ArtifactDraftSectionCitationsReauthorizedRead =
  | (ReauthorizedCitationsCommon & {
    readonly semantic_verification: "NOT_EXECUTED";
    readonly audit?: never;
  })
  | (ReauthorizedCitationsCommon & {
    readonly semantic_verification: "EXECUTED";
    readonly audit: ArtifactDraftSemanticAudit;
  });

interface ProjectionCitationRow {
  readonly item_key: unknown;
  readonly source_revision_ref: unknown;
  readonly canonical_section_id: unknown;
  readonly content_sha256: unknown;
  readonly projection_generation: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
  readonly precision_kind: unknown;
  readonly generation_state: unknown;
  readonly activation_verified: unknown;
}

function fail(
  code: "ARTIFACT_DRAFT_READ_DENIED" | "ARTIFACT_DRAFT_READ_STALE" | "ARTIFACT_DRAFT_READ_INTEGRITY" | "ARTIFACT_DRAFT_READ_UNAVAILABLE",
  status: 403 | 409 | 410 | 503,
  message: string,
  retryable = false,
): never {
  throw new ArtifactDraftReadError(code, status, message, retryable);
}

function parseRef(value: unknown, label: string): VersionedRef {
  try { return VersionedRefSchema.parse(value); }
  catch { fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, `${label} is invalid`); }
}

function accessSnapshot(value: EvidenceAccessContext): EvidenceAccessContext {
  if (value.client_class !== "owner_pwa") {
    fail("ARTIFACT_DRAFT_READ_DENIED", 403, "draft read authorization denied");
  }
  return Object.freeze({
    principal_ref: assertEvidenceIdentifier(value.principal_ref, "citation access principal"),
    client_class: value.client_class,
    credential_generation: assertEvidenceIdentifier(value.credential_generation, "citation access credential"),
  });
}

function authorizationSnapshot(value: ScopeAuthorization): ScopeAuthorization {
  try {
    return Object.freeze(JSON.parse(canonicalEvidenceJson(value)) as ScopeAuthorization);
  } catch (cause) {
    fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "citation authorization is invalid");
  }
}

function mapEvidenceError(error: unknown): never {
  if (error instanceof ArtifactDraftReadError) throw error;
  if (error instanceof EvidenceRuntimeError) {
    if (error.code === "EVIDENCE_AUTHORIZATION_DENIED") {
      fail("ARTIFACT_DRAFT_READ_DENIED", 403, "fresh citation authorization denied");
    }
    if (error.code === "EVIDENCE_INPUT_INVALID") {
      fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "fresh citation authority is inconsistent");
    }
    if (error.code === "EVIDENCE_SETTLEMENT_UNCERTAIN" || error.code === "EVIDENCE_OBJECT_NOT_FOUND") {
      fail("ARTIFACT_DRAFT_READ_UNAVAILABLE", 503, "fresh citation evidence is unavailable", true);
    }
    if (error.code === "EVIDENCE_OBJECT_INTEGRITY" || error.code === "EVIDENCE_IDENTITY_CONFLICT") {
      fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "fresh citation evidence failed integrity validation");
    }
    fail("ARTIFACT_DRAFT_READ_STALE", 410, "saved citation is no longer currently resolvable");
  }
  fail("ARTIFACT_DRAFT_READ_UNAVAILABLE", 503, "fresh citation authority is unavailable", true);
}

function mapNavigationError(error: unknown): never {
  if (error instanceof ArtifactDraftReadError) throw error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  if (code === "EVIDENCE_AUTHORIZATION_DENIED" || code === "NAVIGATION_SCOPE_MISMATCH") {
    fail("ARTIFACT_DRAFT_READ_DENIED", 403, "fresh citation authorization denied");
  }
  if (code === "EVIDENCE_SCOPE_EXPIRED" || code === "EVIDENCE_SCOPE_INVALIDATED" ||
      code === "SCOPE_SNAPSHOT_STALE" || code === "NAVIGATION_SCOPE_NOT_CURRENT") {
    fail("ARTIFACT_DRAFT_READ_STALE", 410, "fresh citation scope is stale");
  }
  if (code === "EVIDENCE_INPUT_INVALID" || code === "SCOPE_SNAPSHOT_READBACK_MISMATCH") {
    fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "fresh citation authority is inconsistent");
  }
  fail("ARTIFACT_DRAFT_READ_UNAVAILABLE", 503, "fresh citation authority is unavailable", true);
}

async function pinnedCandidate(
  database: D1Database,
  handle: EvidenceHandle,
): Promise<LocatorCandidate> {
  if (handle.anchor.kind !== "normalized_byte_range") {
    fail("ARTIFACT_DRAFT_READ_STALE", 410, "saved citation precision cannot be reauthorized");
  }
  let result: D1Result<ProjectionCitationRow>;
  try {
    result = await database.prepare(
      "SELECT p.item_key, p.source_revision_ref, p.canonical_section_id, p.content_sha256, " +
      "p.projection_generation, s.normalized_start_byte, s.normalized_end_byte, s.precision_kind, " +
      "g.state AS generation_state, a.verified AS activation_verified " +
      "FROM projection_item p JOIN projection_span s ON s.item_key = p.item_key " +
      "AND s.source_revision_ref = p.source_revision_ref AND s.projection_generation = p.projection_generation " +
      "JOIN projection_generation_receipt g ON g.source_revision_ref = p.source_revision_ref " +
      "AND g.projection_generation = p.projection_generation " +
      "JOIN projection_activation_guard a ON a.source_revision_ref = p.source_revision_ref " +
      "AND a.projection_generation = p.projection_generation " +
      "WHERE p.source_revision_ref = ?1 AND p.active = 1 AND p.content_sha256 = ?2 " +
      "AND s.normalized_start_byte = ?3 AND s.normalized_end_byte = ?4 " +
      "AND s.precision_kind = 'normalized_bytes' AND g.state = 'READY' AND a.verified = 1 LIMIT 2",
    ).bind(
      handle.source_revision_ref,
      handle.excerpt_sha256,
      handle.anchor.start,
      handle.anchor.end,
    ).all<ProjectionCitationRow>();
  } catch (cause) {
    fail("ARTIFACT_DRAFT_READ_UNAVAILABLE", 503, "fresh citation projection is unavailable", true);
  }
  if (!result.success || !Array.isArray(result.results)) {
    fail("ARTIFACT_DRAFT_READ_UNAVAILABLE", 503, "fresh citation projection readback is unavailable", true);
  }
  if (result.results.length !== 1) {
    fail("ARTIFACT_DRAFT_READ_STALE", 410, "saved citation no longer has one active projection span");
  }
  const row = result.results[0];
  if (row === undefined || row.precision_kind !== "normalized_bytes" || row.generation_state !== "READY" ||
      row.activation_verified !== 1) {
    fail("ARTIFACT_DRAFT_READ_STALE", 410, "saved citation projection is not activated");
  }
  try {
    const sourceRevisionRef = assertEvidenceIdentifier(row.source_revision_ref, "projection source revision");
    const itemKey = assertEvidenceIdentifier(row.item_key, "projection item key");
    const sectionId = assertEvidenceIdentifier(row.canonical_section_id, "projection section");
    const generation = assertEvidenceIdentifier(row.projection_generation, "projection generation");
    const contentSha = assertEvidenceSha256(row.content_sha256, "projection content digest");
    const start = assertEvidenceInteger(row.normalized_start_byte, "projection start");
    const end = assertEvidenceInteger(row.normalized_end_byte, "projection end", start + 1);
    if (sourceRevisionRef !== handle.source_revision_ref || contentSha !== handle.excerpt_sha256 ||
        start !== handle.anchor.start || end !== handle.anchor.end) {
      fail("ARTIFACT_DRAFT_READ_STALE", 410, "saved citation projection changed");
    }
    return LocatorCandidateSchema.parse({
      candidate_id: itemKey,
      lane: "EXACT",
      source_revision_ref: sourceRevisionRef,
      canonical_section_id: sectionId,
      preview: "",
      raw_score: 0,
      rank: 1,
      index_generation: generation,
      metadata: { item_key: itemKey, content_sha256: contentSha },
    });
  } catch (cause) {
    fail("ARTIFACT_DRAFT_READ_STALE", 410, "saved citation projection candidate is invalid");
  }
}

function requireFreshEvidence(
  original: EvidenceHandle,
  fresh: ResolvedEvidence,
  scopeRef: VersionedRef,
  source: {
    readonly source_namespace_id: string;
    readonly source_owner_generation: string;
    readonly content_sha256: string;
    readonly object_residency_key_digest: string;
  },
  authorization: ScopeAuthorization,
  access: EvidenceAccessContext,
  nowIso: string,
): void {
  if (!exactEvidenceRef(fresh.handle.scope_snapshot_ref, scopeRef) ||
      fresh.handle.terminal_state !== "LIVE" ||
      fresh.handle.source_revision_ref !== original.source_revision_ref ||
      fresh.handle.source_namespace_id !== source.source_namespace_id ||
      fresh.handle.source_owner_generation !== source.source_owner_generation ||
      fresh.handle.object_residency_key_digest !== source.object_residency_key_digest ||
      canonicalEvidenceJson(fresh.handle.anchor) !== canonicalEvidenceJson(original.anchor) ||
      (fresh.handle.coordinate_map_ref ?? undefined) !== (original.coordinate_map_ref ?? undefined) ||
      fresh.handle.excerpt_sha256 !== original.excerpt_sha256 ||
      fresh.handle.excerpt_byte_length !== original.excerpt_byte_length ||
      fresh.source_revision_content_sha256 !== source.content_sha256 ||
      fresh.authorization_receipt_ref !== authorization.authorization_receipt_ref ||
      fresh.credential_generation !== access.credential_generation) {
    fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "fresh citation handle is not bound to the saved evidence");
  }
  const expires = fresh.handle.expires_at === undefined ? NaN : Date.parse(fresh.handle.expires_at);
  if (!Number.isSafeInteger(expires) || expires <= Date.parse(nowIso)) {
    fail("ARTIFACT_DRAFT_READ_STALE", 410, "fresh citation handle is already expired");
  }
}

function sourceFingerprint(
  sources: readonly EvidenceSourceAuthority[],
): string {
  return canonicalEvidenceJson([...sources].sort((left, right) => (
    left.source_revision_ref.localeCompare(right.source_revision_ref)
  )));
}

export async function readReauthorizedArtifactDraftSectionCitations(
  rawInput: ArtifactDraftCitationReauthorizationInput,
): Promise<ArtifactDraftSectionCitationsReauthorizedRead | null> {
  const input = rawInput;
  const artifactRef = parseRef(input.artifact_ref, "draft reference");
  const sectionRef = parseRef(input.section_ref, "section reference");
  const access = accessSnapshot(input.access);
  const authorization = authorizationSnapshot(input.current_authorization);
  const navigation = input.current_navigation;
  const deploymentGeneration = input.deployment_generation;
  if (typeof deploymentGeneration !== "string" || deploymentGeneration.length < 1 || deploymentGeneration.length > 256) {
    fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "deployment generation is invalid");
  }
  let freshScope: ReturnType<typeof ScopeSnapshotSchema.parse>;
  try { freshScope = ScopeSnapshotSchema.parse(JSON.parse(canonicalEvidenceJson(navigation.scope))); }
  catch (cause) { fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "fresh citation scope is invalid"); }
  const scopeRef = { id: freshScope.snapshot_id, revision: freshScope.revision };
  const coreInput: ArtifactDraftReauthorizationSectionReadInput = {
    database: input.database,
    work_bucket: input.work_bucket,
    access,
    reauthorization: { navigation, authorization },
    section_ref: sectionRef,
    ...(input.now === undefined ? {} : { now: input.now }),
  };
  let read: ArtifactDraftReauthorizedCoreRead<ArtifactDraftSectionCitationsRead> | null;
  try {
    read = await readArtifactDraftReauthorizedInternal(coreInput, artifactRef, sectionRef, true);
  } catch (error) {
    mapEvidenceError(error);
  }
  if (read === null) return null;
  const original = read.value;
  const originalScopeRef = parseRef(read.original_scope_snapshot_ref, "original scope");
  const originalKeys = new Set<string>();
  const handles = new Map<string, EvidenceHandle>();
  for (const item of original.cited_evidence) {
    const key = evidenceRefKey(item.handle_ref);
    if (originalKeys.has(key)) fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "saved citation handles are duplicated");
    originalKeys.add(key);
    let handle: EvidenceHandle | null;
    try { handle = await loadEvidenceHandle(input.database, item.handle_ref); }
    catch (error) { mapEvidenceError(error); }
    if (handle === null) fail("ARTIFACT_DRAFT_READ_STALE", 410, "saved citation handle is missing");
    if (handle.terminal_state !== "LIVE") {
      fail("ARTIFACT_DRAFT_READ_STALE", 410, "saved citation handle is terminal");
    }
    if (!exactEvidenceRef(handle.scope_snapshot_ref, originalScopeRef) ||
        handle.source_revision_ref.length === 0 || handle.excerpt_sha256 !== item.excerpt_sha256) {
      fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "saved citation handle differs from verification");
    }
    handles.set(key, handle);
  }
  const sourceRefs = [...new Set([...handles.values()].map((handle) => handle.source_revision_ref))].sort();
  let beforeGrant: ScopeAuthorization;
  let beforeSources: Awaited<ReturnType<NavigationReadAuthority["sources"]>>;
  try {
    beforeGrant = await navigation.current();
    beforeSources = await navigation.sources(sourceRefs, beforeGrant);
  } catch (error) {
    mapNavigationError(error);
  }
  if (canonicalEvidenceJson(beforeGrant) !== canonicalEvidenceJson(authorization)) {
    fail("ARTIFACT_DRAFT_READ_STALE", 410, "fresh citation authorization changed");
  }
  const beforeSourceFingerprint = sourceFingerprint(beforeSources);
  const authority = createD1EvidenceAuthorityPort({
    core_database: input.database,
    search_database: input.search_database,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const content = createR2EvidenceContentPort({ evidence_bucket: input.evidence_bucket });
  const resolver = createCloudflareEvidenceResolver({
    authority,
    content,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const citedEvidence: ReauthorizedCitationEvidence[] = [];
  const nowIso = navigation.timestamp();
  for (const item of original.cited_evidence) {
    const handle = handles.get(evidenceRefKey(item.handle_ref));
    if (handle === undefined) fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "saved citation handle readback disappeared");
    const source = beforeSources.find((candidate) => candidate.source_revision_ref === handle.source_revision_ref);
    if (source === undefined || source.source_owner_generation !== handle.source_owner_generation ||
        source.source_namespace_id !== handle.source_namespace_id ||
        source.object_residency_key_digest !== handle.object_residency_key_digest) {
      fail("ARTIFACT_DRAFT_READ_STALE", 410, "saved citation source authority changed");
    }
    const candidate = await pinnedCandidate(input.search_database, handle);
    let fresh;
    try {
      fresh = await resolver.resolveCandidate({ candidate, scope_snapshot_ref: scopeRef, access });
    } catch (error) {
      mapEvidenceError(error);
    }
    try {
      const bytes = evidenceUtf8Bytes(fresh.exact_excerpt);
      if (bytes.byteLength !== handle.excerpt_byte_length || await evidenceSha256Bytes(bytes) !== handle.excerpt_sha256) {
        fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "fresh citation bytes differ from saved evidence");
      }
    } catch (error) {
      mapEvidenceError(error);
    }
    requireFreshEvidence(handle, fresh, scopeRef, source, authorization, access, nowIso);
    citedEvidence.push({
      original_handle_ref: item.handle_ref,
      handle_ref: fresh.handle.handle_ref,
      excerpt_sha256: handle.excerpt_sha256,
    });
  }
  let afterGrant: ScopeAuthorization;
  let afterSources: Awaited<ReturnType<NavigationReadAuthority["sources"]>>;
  try {
    afterGrant = await navigation.current();
    afterSources = await navigation.sources(sourceRefs, afterGrant);
  } catch (error) {
    mapNavigationError(error);
  }
  if (canonicalEvidenceJson(afterGrant) !== canonicalEvidenceJson(authorization)) {
    fail("ARTIFACT_DRAFT_READ_STALE", 410, "fresh citation authorization changed during read");
  }
  if (sourceFingerprint(afterSources) !== beforeSourceFingerprint) {
    fail("ARTIFACT_DRAFT_READ_STALE", 410, "fresh citation source authority changed during read");
  }
  const common: ReauthorizedCitationsCommon = {
    protocol: ARTIFACT_DRAFT_CITATIONS_REAUTHORIZATION_PROTOCOL,
    artifact_ref: original.artifact_ref,
    section_ref: original.section_ref,
    original_scope_snapshot_ref: originalScopeRef,
    authorization_scope_snapshot_ref: scopeRef,
    authorization,
    deployment_generation: deploymentGeneration,
    verification_receipt_ref: original.verification_receipt_ref,
    cited_evidence: Object.freeze(citedEvidence),
  };
  if (original.semantic_verification === "EXECUTED") {
    return { ...common, semantic_verification: "EXECUTED", audit: original.audit };
  }
  return { ...common, semantic_verification: "NOT_EXECUTED" };
}
