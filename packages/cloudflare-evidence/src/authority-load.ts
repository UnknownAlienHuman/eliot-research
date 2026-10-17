import { readD1ScopeSnapshot, ScopePersistenceError } from "./scope-store.js";
import {
  EvidenceHandleSchema,
  LocatorCandidateSchema,
  SourceAdmissionDecisionSchema,
  type EvidenceHandle,
  type LocatorCandidate,
  type SourceAdmissionDecision,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  assertEvidenceIdentifier,
  assertEvidenceInteger,
  assertEvidenceIso,
  assertEvidenceSha256,
  canonicalEvidenceJson,
  evidenceRefKey,
  evidenceSha256,
} from "./canonical.js";
import {
  EvidenceRuntimeError,
  type CandidateAnchorAuthority,
  type EvidenceAccessContext,
  type EvidenceSourceAuthority,
  type FreshEvidenceAuthorityRead,
  type ScopeAuthority,
  type ScopeAuthorization,
} from "./types.js";
import { SCOPE_COLUMNS, decodeStoredScopeRow, scopePersistenceFailure, validateScopeStorageRef } from "./scope-codec.js";

interface GrantRow {
  readonly authorization_receipt_ref: unknown;
  readonly policy_authority_ref: unknown;
  readonly allowed_use_json: unknown;
  readonly disclosure_ceiling: unknown;
  readonly expires_at: unknown;
  readonly state: unknown;
}

interface SourceRow {
  readonly source_id: unknown;
  readonly owner_system_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_generation: unknown;
  readonly source_revision_ref: unknown;
  readonly source_title: unknown;
  readonly source_class: unknown;
  readonly content_sha256: unknown;
  readonly object_residency_key_digest: unknown;
  readonly normalized_artifact_ref: unknown;
  readonly purge_state: unknown;
  readonly current_owner_generation: unknown;
  readonly owner_status: unknown;
  readonly decision_receipt_ref: unknown;
  readonly decision_json: unknown;
  readonly decision_sha256: unknown;
}

interface CandidateRow {
  readonly item_key: unknown;
  readonly source_revision_ref: unknown;
  readonly canonical_section_id: unknown;
  readonly content_sha256: unknown;
  readonly normalized_offset_map_ref: unknown;
  readonly projection_generation: unknown;
  readonly normalized_start_byte: unknown;
  readonly normalized_end_byte: unknown;
  readonly precision_kind: unknown;
  readonly generation_state: unknown;
  readonly activation_verified: unknown;
}

interface HandleRow {
  readonly handle_id: unknown;
  readonly revision: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_generation: unknown;
  readonly source_revision_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly anchor_json: unknown;
  readonly excerpt_sha256: unknown;
  readonly excerpt_byte_length: unknown;
  readonly coordinate_map_ref: unknown;
  readonly loss_map_ref: unknown;
  readonly object_residency_key_digest: unknown;
  readonly source_assurance_ceiling: unknown;
  readonly materializer_assurance_ceiling: unknown;
  readonly terminal_state: unknown;
  readonly invalidation_ref: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
}

function fail(
  code: EvidenceRuntimeError["code"],
  message: string,
  options: ConstructorParameters<typeof EvidenceRuntimeError>[2] = {},
): never {
  throw new EvidenceRuntimeError(code, message, options);
}

function parseJson(raw: unknown, label: string): unknown {
  if (typeof raw !== "string") fail("EVIDENCE_INPUT_INVALID", `${label} is not JSON text`);
  try { return JSON.parse(raw); }
  catch (cause) { fail("EVIDENCE_INPUT_INVALID", `${label} is malformed JSON`, { cause }); }
}

function parseCanonicalJson(raw: unknown, label: string): unknown {
  const parsed = parseJson(raw, label);
  if (canonicalEvidenceJson(parsed) !== raw) {
    fail("EVIDENCE_INPUT_INVALID", `${label} is not canonical JSON`);
  }
  return parsed;
}

function identifierArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 512) {
    fail("EVIDENCE_INPUT_INVALID", `${label} is not a bounded array`);
  }
  const values = value.map((entry) => assertEvidenceIdentifier(entry, `${label} member`));
  if (new Set(values).size !== values.length) {
    fail("EVIDENCE_INPUT_INVALID", `${label} contains duplicates`);
  }
  return values;
}

export async function loadScopeAuthority(
  database: D1Database,
  ref: VersionedRef,
): Promise<ScopeAuthority | null> {
  try { return await readD1ScopeSnapshot(database, ref.id, ref.revision); }
  catch (cause) { return scopeAuthorityReadFailure(cause); }
}

function scopeAuthorityReadFailure(cause: unknown): never {
  if (cause instanceof ScopePersistenceError) {
    fail("EVIDENCE_INPUT_INVALID", "stored ScopeSnapshot failed integrity validation", { cause });
  }
  fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "ScopeSnapshot authority read is unavailable", { retryable: true, cause });
}

export async function authorizeScopeAuthority(
  database: D1Database,
  scope: ScopeAuthority,
  access: EvidenceAccessContext,
  nowMs: number,
): Promise<ScopeAuthorization> {
  assertScopeAuthorizationCurrent(scope, access, nowMs);
  const row = await database.prepare(
    scopeAuthorizationSql,
  ).bind(
    scope.snapshot.snapshot_id,
    scope.snapshot.revision,
    access.principal_ref,
    access.client_class,
    access.credential_generation,
  ).first<GrantRow>();
  return decodeScopeAuthorizationRow(scope, nowMs, row);
}

const scopeAuthorizationSql =
  "SELECT authorization_receipt_ref, policy_authority_ref, allowed_use_json, " +
  "disclosure_ceiling, expires_at, state FROM scope_access_grant_effective " +
  "WHERE snapshot_id = ?1 AND snapshot_revision = ?2 AND principal_ref = ?3 " +
  "AND client_class = ?4 AND credential_generation = ?5 LIMIT 1";

const scopeMembersCurrentSql =
  "SELECT 1 AS unavailable FROM scope_snapshot snapshot, json_each(snapshot.member_source_revision_refs_json) member " +
  "WHERE snapshot.snapshot_id=?1 AND snapshot.revision=?2 AND NOT EXISTS (" +
  "SELECT 1 FROM source_revision sr JOIN source s ON s.source_id=sr.source_id " +
  "JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id AND o.status='ACTIVE' " +
  "JOIN json_each(snapshot.source_owner_generations_json) gen ON gen.key=member.value " +
  "WHERE sr.source_revision_ref=member.value AND sr.purge_state='LIVE' " +
  "AND sr.source_owner_generation=o.source_owner_generation AND gen.value=sr.source_owner_generation) LIMIT 1";

function assertScopeAuthorizationCurrent(
  scope: ScopeAuthority,
  access: EvidenceAccessContext,
  nowMs: number,
): void {
  if (scope.invalidated_at !== null) {
    fail("EVIDENCE_SCOPE_INVALIDATED", "ScopeSnapshot is invalidated", { invalidation_state: "STALE" });
  }
  if (Date.parse(scope.snapshot.expires_at) <= nowMs) {
    fail("EVIDENCE_SCOPE_EXPIRED", "ScopeSnapshot expired", { invalidation_state: "STALE" });
  }
  if (
    scope.snapshot.client_fence_ref !== undefined &&
    scope.snapshot.client_fence_ref !== access.credential_generation
  ) {
    fail("EVIDENCE_AUTHORIZATION_DENIED", "client fence does not match current credential generation");
  }
}

function decodeScopeAuthorizationRow(
  scope: ScopeAuthority,
  nowMs: number,
  row: GrantRow | null,
): ScopeAuthorization {
  if (row === null || row.state !== "ACTIVE") {
    fail("EVIDENCE_AUTHORIZATION_DENIED", "no active exact ScopeSnapshot authorization exists");
  }
  const expiresAt = assertEvidenceIso(row.expires_at, "scope authorization expires_at");
  if (Date.parse(expiresAt) <= nowMs) {
    fail("EVIDENCE_AUTHORIZATION_DENIED", "ScopeSnapshot authorization expired");
  }
  const policyAuthorityRef = assertEvidenceIdentifier(
    row.policy_authority_ref,
    "scope authorization policy authority",
  );
  if (policyAuthorityRef !== scope.snapshot.policy_authority_ref) {
    fail("EVIDENCE_AUTHORIZATION_DENIED", "scope authorization policy authority mismatch");
  }
  return {
    authorization_receipt_ref: assertEvidenceIdentifier(
      row.authorization_receipt_ref,
      "scope authorization receipt",
    ),
    policy_authority_ref: policyAuthorityRef,
    allowed_use: identifierArray(
      parseCanonicalJson(row.allowed_use_json, "scope authorization allowed use"),
      "scope authorization allowed use",
    ),
    disclosure_ceiling: assertEvidenceIdentifier(
      row.disclosure_ceiling,
      "scope authorization disclosure ceiling",
    ),
    expires_at: expiresAt,
  };
}

/** One primary-D1 transaction per fence: scope, live members, then the exact grant. */
export async function loadScopeCurrentness(
  database: D1Database,
  ref: VersionedRef,
  access: EvidenceAccessContext,
): Promise<{ readonly scope: ScopeAuthority | null; readonly members_current: boolean; authorize(nowMs: number): ScopeAuthorization }> {
  let results: D1Result<unknown>[];
  try {
    results = await database.batch([
      database.prepare(`SELECT ${SCOPE_COLUMNS} FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2 LIMIT 1`)
        .bind(ref.id, ref.revision),
      database.prepare(scopeMembersCurrentSql).bind(ref.id, ref.revision),
      database.prepare(scopeAuthorizationSql).bind(
        ref.id, ref.revision, access.principal_ref, access.client_class, access.credential_generation,
      ),
    ]);
  } catch (cause) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "scope currentness batch read is unavailable", { retryable: true, cause });
  }
  const scopeResult = results[0];
  const membersResult = results[1];
  const grantResult = results[2];
  if (results.length !== 3 || scopeResult?.success !== true || membersResult?.success !== true || grantResult?.success !== true ||
      !Array.isArray(scopeResult.results) || !Array.isArray(membersResult.results) || !Array.isArray(grantResult.results) ||
      scopeResult.results.length > 1 || membersResult.results.length > 1 || grantResult.results.length > 1) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "scope currentness batch read is incomplete", { retryable: true });
  }
  const membersCurrent = membersResult.results.length === 0;
  const rawScope = scopeResult.results[0] as Record<string, unknown> | undefined;
  if (rawScope === undefined) return {
    scope: null,
    members_current: membersCurrent,
    authorize: () => fail("EVIDENCE_SCOPE_NOT_FOUND", "persisted ScopeSnapshot is missing"),
  };
  let scope: ScopeAuthority;
  try { scope = await decodeStoredScopeRow(rawScope); }
  catch (cause) {
    if (cause instanceof ScopePersistenceError) {
      fail("EVIDENCE_INPUT_INVALID", "stored ScopeSnapshot failed integrity validation", { cause });
    }
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "ScopeSnapshot authority decode is unavailable", { retryable: true, cause });
  }
  if (scope.snapshot.snapshot_id !== ref.id || scope.snapshot.revision !== ref.revision) {
    fail("EVIDENCE_INPUT_INVALID", "ScopeSnapshot authority identity mismatch");
  }
  const grantRow = (grantResult.results[0] as GrantRow | undefined) ?? null;
  return {
    scope,
    members_current: membersCurrent,
    authorize: (nowMs) => {
      assertScopeAuthorizationCurrent(scope, access, nowMs);
      return decodeScopeAuthorizationRow(scope, nowMs, grantRow);
    },
  };
}

async function parseAdmissionDecision(row: SourceRow): Promise<SourceAdmissionDecision> {
  const raw = parseCanonicalJson(row.decision_json, "source admission decision");
  let decision: SourceAdmissionDecision;
  try { decision = SourceAdmissionDecisionSchema.parse(raw); }
  catch (cause) {
    fail("EVIDENCE_INPUT_INVALID", "source admission decision failed strict decoding", { cause });
  }
  const digest = assertEvidenceSha256(row.decision_sha256, "source admission decision digest");
  if (await evidenceSha256(decision) !== digest) {
    fail("EVIDENCE_INPUT_INVALID", "source admission decision digest mismatch");
  }
  return decision;
}

const sourceAuthoritySql =
    "SELECT s.source_id, s.source_owner_system_id AS owner_system_id, " +
    "s.source_namespace_id, sr.source_owner_generation, " +
    "sr.source_revision_ref, s.title AS source_title, s.source_class, sr.content_sha256, " +
    "sr.object_residency_key_digest, sr.normalized_artifact_ref, sr.purge_state, " +
    "o.source_owner_generation AS current_owner_generation, o.status AS owner_status, " +
    "d.decision_receipt_ref, d.decision_json, d.decision_sha256 " +
    "FROM source_revision sr JOIN source s ON s.source_id = sr.source_id " +
    "LEFT JOIN source_namespace_ownership o ON o.source_namespace_id = s.source_namespace_id " +
    "AND o.status = 'ACTIVE' " +
    "LEFT JOIN source_admission_decision d ON d.source_revision_ref = sr.source_revision_ref " +
    "AND d.decision = 'ADMITTED' " +
    "WHERE sr.source_revision_ref = ?1 ORDER BY d.created_at DESC LIMIT 1";

export async function loadSourceAuthority(
  database: D1Database,
  sourceRevisionRef: string,
  nowMs: number,
): Promise<EvidenceSourceAuthority | null> {
  const row = await database.prepare(sourceAuthoritySql).bind(sourceRevisionRef).first<SourceRow>();
  if (row === null) return null;
  return decodeSourceAuthority(row, nowMs);
}

function authorityBatchRow<T>(results: readonly D1Result<unknown>[], index: number): T | null {
  const result = results[index];
  if (result?.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
    throw new Error(result?.error ?? "D1 authority read result is incomplete");
  }
  return (result.results[0] as T | undefined) ?? null;
}

/** Same primary-D1 SELECTs in one fresh transaction; decode scope, grant, then source in caller order. */
export async function loadFreshEvidenceAuthority(
  database: D1Database,
  ref: VersionedRef,
  access: EvidenceAccessContext,
  sourceRevisionRef: string,
  now: () => number,
): Promise<FreshEvidenceAuthorityRead> {
  const readTime = (): number => {
    const observed = now();
    if (!Number.isSafeInteger(observed) || observed < 0) throw new RangeError("evidence authority clock is invalid");
    return observed;
  };
  try { validateScopeStorageRef(ref.id, ref.revision); }
  catch (cause) { return scopeAuthorityReadFailure(cause); }
  let results: D1Result<unknown>[];
  try {
    results = await database.batch([
      database.prepare(`SELECT ${SCOPE_COLUMNS} FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2 LIMIT 1`)
        .bind(ref.id, ref.revision),
      database.prepare(scopeAuthorizationSql).bind(
        ref.id, ref.revision, access.principal_ref, access.client_class, access.credential_generation,
      ),
      database.prepare(sourceAuthoritySql).bind(sourceRevisionRef),
    ]);
  } catch {
    // D1 can reject the whole read batch without individual results. Use the
    // original ordered reads so a later SELECT failure cannot mask an earlier denial.
    const scope = await loadScopeAuthority(database, ref);
    return {
      scope,
      authorize: async () => {
        if (scope === null) fail("EVIDENCE_SCOPE_NOT_FOUND", "ScopeSnapshot does not exist");
        return authorizeScopeAuthority(database, scope, access, readTime());
      },
      loadSource: () => loadSourceAuthority(database, sourceRevisionRef, readTime()),
    };
  }
  let scope: ScopeAuthority | null;
  try {
    if (!Array.isArray(results) || results.length > 3) throw new Error("D1 authority read batch is invalid");
    const row = authorityBatchRow<Record<string, unknown>>(results, 0);
    scope = row === null ? null : await decodeStoredScopeRow(row);
    if (scope !== null && (scope.snapshot.snapshot_id !== ref.id || scope.snapshot.revision !== ref.revision)) {
      scopePersistenceFailure("SCOPE_STORAGE_READBACK_MISMATCH");
    }
  } catch (cause) { return scopeAuthorityReadFailure(cause); }
  return {
    scope,
    authorize: async () => {
      if (scope === null) fail("EVIDENCE_SCOPE_NOT_FOUND", "ScopeSnapshot does not exist");
      const observed = readTime();
      assertScopeAuthorizationCurrent(scope, access, observed);
      return decodeScopeAuthorizationRow(scope, observed, authorityBatchRow<GrantRow>(results, 1));
    },
    // Source errors remain deferred past handle expiry and inside its invalidation catch.
    loadSource: async () => {
      const observed = readTime();
      const row = authorityBatchRow<SourceRow>(results, 2);
      return row === null ? null : decodeSourceAuthority(row, observed);
    },
  };
}

export async function loadSourceAuthorities(
  database: D1Database, refs: readonly string[], nowMs: number,
): Promise<readonly EvidenceSourceAuthority[]> {
  if (!Array.isArray(refs) || refs.length > 64 || new Set(refs).size !== refs.length) {
    fail("EVIDENCE_INPUT_INVALID", "source authority batch exceeds its bound or repeats identities");
  }
  refs.forEach((ref) => assertEvidenceIdentifier(ref, "source revision"));
  if (refs.length === 0) return [];
  const result = await database.prepare(
    "SELECT s.source_id, s.source_owner_system_id AS owner_system_id, " +
    "s.source_namespace_id, sr.source_owner_generation, " +
    "sr.source_revision_ref, s.title AS source_title, s.source_class, sr.content_sha256, " +
    "sr.object_residency_key_digest, sr.normalized_artifact_ref, sr.purge_state, " +
    "o.source_owner_generation AS current_owner_generation, o.status AS owner_status, " +
    "d.decision_receipt_ref, CASE WHEN length(CAST(d.decision_json AS BLOB)) <= 65536 " +
    "THEN d.decision_json ELSE NULL END AS decision_json, d.decision_sha256 " +
    "FROM source_revision sr JOIN source s ON s.source_id = sr.source_id " +
    "LEFT JOIN source_namespace_ownership o ON o.source_namespace_id = s.source_namespace_id " +
    "AND o.status = 'ACTIVE' " +
    "LEFT JOIN source_admission_decision d ON d.source_revision_ref = sr.source_revision_ref " +
    "AND d.decision = 'ADMITTED' " +
    "WHERE sr.source_revision_ref IN (SELECT value FROM json_each(?1)) " +
    "AND d.decision_receipt_ref = (SELECT chosen.decision_receipt_ref FROM source_admission_decision chosen " +
    "WHERE chosen.source_revision_ref = sr.source_revision_ref AND chosen.decision = 'ADMITTED' " +
    "ORDER BY chosen.created_at DESC, chosen.decision_receipt_ref DESC LIMIT 1) " +
    "ORDER BY sr.source_revision_ref LIMIT 65",
  ).bind(JSON.stringify(refs)).all<SourceRow>();
  if (!result.success || !Array.isArray(result.results)) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "source authority batch unavailable", { retryable: true });
  }
  const rows = result.results;
  if (rows.length > refs.length || new Set(rows.map((row) => row.source_revision_ref)).size !== rows.length ||
      rows.some((row) => typeof row.source_revision_ref !== "string" || !refs.includes(row.source_revision_ref))) {
    fail("EVIDENCE_INPUT_INVALID", "source authority batch identity mismatch");
  }
  return Promise.all(rows.map((row) => decodeSourceAuthority(row, nowMs)));
}

async function decodeSourceAuthority(row: SourceRow, nowMs: number): Promise<EvidenceSourceAuthority> {
  const decision = await parseAdmissionDecision(row);
  const ownerGeneration = assertEvidenceIdentifier(
    row.source_owner_generation,
    "source revision owner generation",
  );
  if (row.owner_status !== "ACTIVE" || row.current_owner_generation !== ownerGeneration) {
    fail("EVIDENCE_OWNER_GENERATION_MISMATCH", "source owner generation is no longer active", {
      invalidation_state: "STALE",
    });
  }
  if (decision.decision !== "ADMITTED") {
    fail("EVIDENCE_SOURCE_NOT_LIVE", "source admission authority is not ADMITTED");
  }
  if (decision.expires_at !== undefined && Date.parse(decision.expires_at) <= nowMs) {
    fail("EVIDENCE_SOURCE_NOT_LIVE", "source admission decision expired", {
      invalidation_state: "STALE",
    });
  }
  const purgeState = row.purge_state;
  if (
    purgeState !== "LIVE" && purgeState !== "QUARANTINED" &&
    purgeState !== "PURGE_REQUESTED" && purgeState !== "REDACTED" &&
    purgeState !== "RETENTION_BLOCKED"
  ) {
    fail("EVIDENCE_INPUT_INVALID", "source purge state is malformed");
  }
  const normalizedArtifactRef = assertEvidenceIdentifier(
    row.normalized_artifact_ref,
    "normalized artifact ref",
  );
  const authority: EvidenceSourceAuthority = {
    source_id: assertEvidenceIdentifier(row.source_id, "source_id"),
    owner_system_id: assertEvidenceIdentifier(row.owner_system_id, "owner system"),
    source_namespace_id: assertEvidenceIdentifier(row.source_namespace_id, "source namespace"),
    source_owner_generation: ownerGeneration,
    source_revision_ref: assertEvidenceIdentifier(row.source_revision_ref, "source revision"),
    source_title: typeof row.source_title === "string" && row.source_title.length > 0
      ? row.source_title
      : fail("EVIDENCE_INPUT_INVALID", "source title is invalid"),
    source_class: assertEvidenceIdentifier(row.source_class, "source class"),
    content_sha256: assertEvidenceSha256(row.content_sha256, "source content digest"),
    object_residency_key_digest: assertEvidenceSha256(
      row.object_residency_key_digest,
      "source residency digest",
    ),
    normalized_artifact_ref: normalizedArtifactRef,
    purge_state: purgeState,
    admission_receipt_ref: assertEvidenceIdentifier(
      row.decision_receipt_ref,
      "admission receipt ref",
    ),
    source_assurance_ceiling: decision.assurance_ceiling,
    instruction_taint: decision.instruction_taint,
    allowed_effects: decision.allowed_effects,
    allowed_use: decision.allowed_use,
    disclosure_ceiling: decision.disclosure_ceiling,
    ...(decision.expires_at === undefined ? {} : { admission_expires_at: decision.expires_at }),
  };
  if (
    decision.source_namespace_id !== authority.source_namespace_id ||
    decision.owner_system_id !== authority.owner_system_id ||
    decision.source_owner_generation !== authority.source_owner_generation ||
    decision.source_revision_ref !== authority.source_revision_ref ||
    decision.object_residency_key_digest !== authority.object_residency_key_digest
  ) {
    fail("EVIDENCE_INPUT_INVALID", "source admission authority conflicts with SourceRevision");
  }
  return authority;
}

function parseLocatorCandidate(rawCandidate: LocatorCandidate): LocatorCandidate {
  try { return LocatorCandidateSchema.parse(rawCandidate); }
  catch (cause) { fail("EVIDENCE_INPUT_INVALID", "locator candidate failed strict decoding", { cause }); }
}

async function resolveCandidateAuthorityFromSearch(
  database: D1Database,
  candidate: LocatorCandidate,
): Promise<CandidateAnchorAuthority> {
  const projectionGeneration = candidate.index_generation;
  const result = await database.prepare(
    "SELECT p.item_key, p.source_revision_ref, p.canonical_section_id, p.content_sha256, " +
    "p.normalized_offset_map_ref, p.projection_generation, s.normalized_start_byte, " +
    "s.normalized_end_byte, s.precision_kind, g.state AS generation_state, " +
    "a.verified AS activation_verified FROM projection_item p " +
    "JOIN projection_span s ON s.item_key = p.item_key " +
    "AND s.source_revision_ref = p.source_revision_ref " +
    "AND s.projection_generation = p.projection_generation " +
    "JOIN projection_generation_receipt g ON g.source_revision_ref = p.source_revision_ref " +
    "AND g.projection_generation = p.projection_generation " +
    "JOIN projection_activation_guard a ON a.source_revision_ref = p.source_revision_ref " +
    "AND a.projection_generation = p.projection_generation " +
    "WHERE p.source_revision_ref = ?1 AND p.canonical_section_id = ?2 " +
    "AND p.projection_generation = ?3 AND p.active = 1 LIMIT 2",
  ).bind(candidate.source_revision_ref, candidate.canonical_section_id, projectionGeneration).all<CandidateRow>();
  const rows = result.results ?? [];
  if (rows.length !== 1) {
    fail("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "locator does not resolve to one active projection span");
  }
  const row = rows[0];
  if (row === undefined || row.generation_state !== "READY" || row.activation_verified !== 1) {
    fail("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "locator projection generation is not activated");
  }
  const itemKey = assertEvidenceIdentifier(row.item_key, "projection item key");
  const metadataItemKey = candidate.metadata.item_key;
  if (metadataItemKey !== undefined && metadataItemKey !== itemKey) {
    fail("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "locator metadata item key conflicts with D1 Search authority");
  }
  const sourceRevision = assertEvidenceIdentifier(row.source_revision_ref, "projection source revision");
  if (
    sourceRevision !== candidate.source_revision_ref ||
    row.canonical_section_id !== candidate.canonical_section_id ||
    row.projection_generation !== projectionGeneration ||
    row.precision_kind !== "normalized_bytes"
  ) {
    fail("EVIDENCE_LOCATOR_NOT_RESOLVABLE", "locator conflicts with active projection authority");
  }
  const start = assertEvidenceInteger(row.normalized_start_byte, "normalized start byte");
  const end = assertEvidenceInteger(row.normalized_end_byte, "normalized end byte", start + 1);
  if (end <= start) fail("EVIDENCE_RANGE_INVALID", "projection span is empty or reversed");
  return {
    anchor: { kind: "normalized_byte_range", start, end },
    item_key: itemKey,
    content_sha256: assertEvidenceSha256(row.content_sha256, "projection content digest"),
    coordinate_map_ref: assertEvidenceIdentifier(
      row.normalized_offset_map_ref,
      "normalized offset map ref",
    ),
    projection_generation: assertEvidenceIdentifier(
      row.projection_generation,
      "projection generation",
    ),
  };
}

export async function resolveCandidateAuthority(
  database: D1Database,
  rawCandidate: LocatorCandidate,
): Promise<CandidateAnchorAuthority> {
  return resolveCandidateAuthorityFromSearch(database, parseLocatorCandidate(rawCandidate));
}

export async function loadEvidenceHandle(
  database: D1Database,
  ref: VersionedRef,
): Promise<EvidenceHandle | null> {
  const row = await database.prepare(
    "SELECT handle_id, revision, source_namespace_id, source_owner_generation, " +
    "source_revision_ref, scope_snapshot_id, scope_snapshot_revision, anchor_json, " +
    "excerpt_sha256, excerpt_byte_length, coordinate_map_ref, loss_map_ref, " +
    "object_residency_key_digest, source_assurance_ceiling, materializer_assurance_ceiling, " +
    "terminal_state, invalidation_ref, created_at, expires_at FROM evidence_handle " +
    "WHERE handle_id = ?1 AND revision = ?2 LIMIT 1",
  ).bind(ref.id, ref.revision).first<HandleRow>();
  if (row === null) return null;
  try {
    return EvidenceHandleSchema.parse({
      handle_ref: { id: row.handle_id, revision: row.revision },
      source_namespace_id: row.source_namespace_id,
      source_owner_generation: row.source_owner_generation,
      source_revision_ref: row.source_revision_ref,
      scope_snapshot_ref: { id: row.scope_snapshot_id, revision: row.scope_snapshot_revision },
      anchor: parseCanonicalJson(row.anchor_json, "evidence anchor"),
      excerpt_sha256: row.excerpt_sha256,
      excerpt_byte_length: row.excerpt_byte_length,
      ...(row.coordinate_map_ref === null ? {} : { coordinate_map_ref: row.coordinate_map_ref }),
      ...(row.loss_map_ref === null ? {} : { loss_map_ref: row.loss_map_ref }),
      object_residency_key_digest: row.object_residency_key_digest,
      source_assurance_ceiling: row.source_assurance_ceiling,
      materializer_assurance_ceiling: row.materializer_assurance_ceiling,
      terminal_state: row.terminal_state,
      ...(row.invalidation_ref === null ? {} : { invalidation_ref: row.invalidation_ref }),
      created_at: row.created_at,
      ...(row.expires_at === null ? {} : { expires_at: row.expires_at }),
    });
  } catch (cause) {
    fail("EVIDENCE_INPUT_INVALID", `stored EvidenceHandle ${evidenceRefKey(ref)} is malformed`, { cause });
  }
}
