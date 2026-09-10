import { SourceRevisionSchema, BundleAdmissionReceiptSchema,
  type BundleAdmissionReceipt, type ScopeSnapshot, type SourceRevision } from "@eliotr/contracts";
import { NavigationError } from "@eliotr/retrieval";
<<<<<<< 3c85450d6618cfa04646e73ddb5596f1207f4454
import { canonicalDigest } from "@eliotr/platform-cloudflare";
=======
import { canonicalDigest } from "@eliotr/contracts";
>>>>>>> f1e678cc20eec9787d2c803f65a2ac0426827f0d
import {
  canonicalEvidenceJson, evidenceSha256, loadSourceAuthorities,
  type EvidenceAccessContext, type EvidenceSourceAuthority,
} from "@eliotr/cloudflare-evidence";
import type { DeterministicScopeAtom } from "@eliotr/domain";
import type { ScopeAuthorityRequest, ScopeRepository } from "./scope-service.js";
import { ORIENTATION_MAX_SOURCES, orientationFail, orientationId } from "./orientation-input.js";

type Bind = string | number | null;
interface PolicyRow {
  source_namespace_id: string; policy_ref: string; generation: number; allowed_use_json: string;
  disclosure_ceiling: string; expires_at: string;
}
interface SourceRow {
  source_revision_ref: string; source_id: string; source_namespace_id: string; source_owner_system_id: string;
  source_owner_generation: string; ownership_mode: string; content_sha256: string; object_residency_key_digest: string;
  normalized_artifact_ref: string; captured_at: string; parser_profile_generation: string | null;
  quality_state: string; purge_state: string; title: string; kind: string; source_class: string;
}
export interface OrientationSource {
  readonly revision: SourceRevision;
  readonly authority: EvidenceSourceAuthority;
  readonly policy: PolicyRow;
  readonly policy_uses: readonly string[];
  readonly policy_closure_ref: string;
  readonly title: string;
  readonly kind: string;
  /**
   * Durable bundle admission re-read from D1 at authority load (never the
   * mutable revision ref alone). `null` only when D1 authoritatively reports
   * NO_NORMALIZED_BUNDLE_ADMISSION; materialization then keeps the source on
   * the explicit metadata-only profile instead of the structural contour.
   */
  readonly bundle_admission: DurableBundleAdmission | null;
}

/**
 * Durable D1 ingest/bundle admission receipt, re-read by exact source-revision
 * identity and digest-verified against its stored readback. This is the
 * authority orientation reconciles the mutable source revision, the manifest
 * reference, residency digests and promotion readbacks against.
 */
function admissionFail(code: "NAVIGATION_SOURCE_MISMATCH" | "NAVIGATION_ARTIFACT_INVALID", message: string): never {
  throw new NavigationError(code, message);
}

export interface DurableBundleAdmission {
  readonly operation_id: string;
  readonly receipt: BundleAdmissionReceipt;
  readonly receipt_sha256: string;
  readonly promotion_receipt_ref: string;
}

interface BundleReceiptRow {
  operation_id: string;
  bundle_receipt_json: string | null;
  bundle_receipt_sha256: string | null;
  promotion_receipt_ref: string | null;
  state: string;
}

/**
 * Re-read the durable bundle admission receipt for one source revision.
 * Returns the latest COMMITTED operation carrying a persisted receipt, with
 * its JSON strictly decoded and digest-verified. Returns `null` only when no
 * committed receipt exists at all (D1 proof of NO_NORMALIZED_BUNDLE_ADMISSION
 * when the revision also carries no manifest reference).
 */
export async function loadDurableBundleAdmission(
  database: D1Database,
  sourceRevisionRef: string,
): Promise<DurableBundleAdmission | null> {
  orientationId(sourceRevisionRef);
  const row = await database.prepare(
    "SELECT operation_id, bundle_receipt_json, bundle_receipt_sha256, " +
    "promotion_receipt_ref, state FROM bundle_ingest_operation " +
    "WHERE source_revision_ref = ?1 AND state = 'COMMITTED' AND bundle_receipt_json IS NOT NULL " +
    "ORDER BY created_at DESC, operation_id DESC LIMIT 1",
  ).bind(sourceRevisionRef).first<BundleReceiptRow>();
  if (row === null) return null;
  if (typeof row.bundle_receipt_json !== "string" || typeof row.bundle_receipt_sha256 !== "string"
    || typeof row.promotion_receipt_ref !== "string") {
    admissionFail("NAVIGATION_ARTIFACT_INVALID", "durable bundle admission receipt is incomplete");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.bundle_receipt_json);
  } catch {
    admissionFail("NAVIGATION_ARTIFACT_INVALID", "durable bundle admission receipt is malformed JSON");
  }
  let receipt: BundleAdmissionReceipt;
  try {
    receipt = BundleAdmissionReceiptSchema.parse(parsed);
  } catch {
    admissionFail("NAVIGATION_ARTIFACT_INVALID", "durable bundle admission receipt failed strict decoding");
  }
  if (await canonicalDigest(receipt) !== row.bundle_receipt_sha256) {
    admissionFail("NAVIGATION_SOURCE_MISMATCH", "durable bundle admission receipt digest mismatch");
  }
  return {
    operation_id: orientationId(row.operation_id),
    receipt,
    receipt_sha256: row.bundle_receipt_sha256,
    promotion_receipt_ref: row.promotion_receipt_ref,
  };
}

/**
 * Reconcile the mutable current revision against its durable admission
 * receipt: exact equality of source revision, owner generation, manifest
 * reference (never trust the mutable ref alone) and residency digest.
 * A missing receipt for a revision that claims an admitted manifest reference
 * is an integrity failure, never a metadata downgrade.
 */
export function reconcileDurableAdmission(
  revision: SourceRevision,
  authority: EvidenceSourceAuthority,
  admission: DurableBundleAdmission | null,
): DurableBundleAdmission | null {
  if (admission === null) {
    if (typeof authority.normalized_artifact_ref === "string" && authority.normalized_artifact_ref.length > 0) {
      admissionFail("NAVIGATION_SOURCE_MISMATCH", "admitted manifest reference has no durable bundle receipt");
    }
    return null;
  }
  const receipt = admission.receipt;
  if (receipt.source_revision_ref !== revision.source_revision_ref
    || receipt.source_revision_ref !== authority.source_revision_ref
    || receipt.normalized_artifact_ref !== authority.normalized_artifact_ref
    || receipt.normalized_artifact_ref !== revision.normalized_artifact_ref
    || receipt.object_residency_key_digest !== authority.object_residency_key_digest
    || receipt.object_residency_key_digest !== revision.object_residency_key_digest
    || authority.source_owner_generation !== revision.source_owner_generation
    || authority.source_namespace_id !== revision.source_namespace_id
    || authority.owner_system_id !== revision.source_owner_system_id) {
    admissionFail("NAVIGATION_SOURCE_MISMATCH", "durable bundle admission disagrees with the current revision");
  }
  return admission;
}
export interface OwnerScopeAuthority extends Pick<ScopeRepository, "resolveAtom" | "resolveAuthorityClosure"> {
  requireReadPolicy(): Promise<void>;
  sources(refs: readonly string[]): Promise<readonly OrientationSource[]>;
  grant(snapshot: ScopeSnapshot): Promise<void>;
}
const columns = "r.source_revision_ref, s.source_id, s.source_namespace_id, s.source_owner_system_id, " +
  "r.source_owner_generation, s.ownership_mode, r.content_sha256, r.object_residency_key_digest, " +
  "r.normalized_artifact_ref, r.captured_at, r.parser_profile_generation, r.quality_state, r.purge_state, " +
  "CASE WHEN length(CAST(s.title AS BLOB))<=4096 THEN s.title ELSE NULL END AS title, s.kind, s.source_class";

/** Read policy is explicit and independent of both Access authentication and ingestion admission. */
export function createOwnerScopeAuthority(db: D1Database, context: EvidenceAccessContext,
  now: () => number = Date.now): OwnerScopeAuthority {
  const access: EvidenceAccessContext = { principal_ref: context.principal_ref,
    client_class: context.client_class, credential_generation: context.credential_generation };
  if (access.client_class !== "owner_pwa") orientationFail("ORIENTATION_OWNER_REQUIRED", 403);
  orientationId(access.principal_ref); orientationId(access.credential_generation);
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) orientationFail("ORIENTATION_CLOCK_INVALID", 503);
    return new Date(value).toISOString();
  };
  async function all<T>(sql: string, values: Bind[]): Promise<T[]> {
    const result = await db.prepare(sql).bind(...values).all<T>();
    if (!result.success || !Array.isArray(result.results)) orientationFail("ORIENTATION_AUTHORITY_UNAVAILABLE", 503, true);
    if (result.results.length > ORIENTATION_MAX_SOURCES) orientationFail("ORIENTATION_SCOPE_LIMIT", 413);
    return result.results;
  }
  async function policies(): Promise<Map<string, PolicyRow>> {
    const rows = await all<PolicyRow>("SELECT source_namespace_id, policy_ref, generation, " +
      "CASE WHEN length(CAST(allowed_use_json AS BLOB))<=4096 THEN allowed_use_json ELSE NULL END AS allowed_use_json, " +
      "disclosure_ceiling, expires_at FROM scope_read_policy WHERE principal_ref=?1 AND client_class=?2 " +
      "AND state='ACTIVE' AND julianday(expires_at)>julianday(?3) ORDER BY source_namespace_id LIMIT 65",
    [access.principal_ref, access.client_class, clock()]);
    if (!rows.length) orientationFail("ORIENTATION_READ_POLICY_REQUIRED", 403);
    for (const row of rows) {
      orientationId(row.source_namespace_id); orientationId(row.policy_ref); orientationId(row.disclosure_ceiling);
      if (!Number.isSafeInteger(row.generation) || row.generation < 1 || !Number.isFinite(Date.parse(row.expires_at))) {
        orientationFail("ORIENTATION_POLICY_INVALID", 503);
      }
      uses(row);
    }
    return new Map(rows.map((row) => [row.source_namespace_id, row]));
  }
  function uses(policy: PolicyRow): string[] {
    let parsed: unknown;
    try { parsed = JSON.parse(policy.allowed_use_json); } catch { orientationFail("ORIENTATION_POLICY_INVALID", 503); }
    if (!Array.isArray(parsed) || parsed.length > 16 || !parsed.includes("research") ||
        new Set(parsed).size !== parsed.length || canonicalEvidenceJson(parsed) !== policy.allowed_use_json) {
      orientationFail("ORIENTATION_POLICY_INVALID", 503);
    }
    return parsed.map(orientationId);
  }
  async function decode(rows: SourceRow[], policyRows: Map<string, PolicyRow>): Promise<OrientationSource[]> {
    const authorities = await loadSourceAuthorities(db, rows.map((row) => row.source_revision_ref), now());
    if (authorities.length !== rows.length) orientationFail("ORIENTATION_SOURCE_NOT_ADMITTED", 403);
    const byRef = new Map(authorities.map((authority) => [authority.source_revision_ref, authority]));
    return Promise.all(rows.map(async (row) => {
      const policy = policyRows.get(row.source_namespace_id);
      const authority = byRef.get(row.source_revision_ref);
      if (!policy || !authority || authority.purge_state !== "LIVE" || !authority.allowed_use.includes("research") ||
          authority.disclosure_ceiling !== policy.disclosure_ceiling ||
          authority.allowed_use.some((use) => !uses(policy).includes(use))) orientationFail("ORIENTATION_SOURCE_DENIED", 403);
      if (typeof row.title !== "string" || !row.title.length || row.title !== authority.source_title ||
          row.source_class !== authority.source_class || !["high_fidelity", "standard", "degraded"].includes(row.quality_state)) {
        orientationFail("ORIENTATION_SOURCE_METADATA_INVALID", 409);
      }
      const { title, kind, source_class: _sourceClass, parser_profile_generation: parser, ...revisionFields } = row;
      const revision = SourceRevisionSchema.parse({ ...revisionFields,
        ...(parser === null ? {} : { parser_profile_generation: parser }) });
      const policyClosure = `read-${await evidenceSha256({ policy, authority, revision, title, kind })}`;
      // Authority load re-reads the durable D1 ingest/bundle admission receipt
      // by exact receipt identity and reconciles the mutable revision against
      // it. Orientation never trusts source_revision.normalized_artifact_ref
      // alone; a claimed manifest reference without a digest-verified durable
      // receipt fails closed here, never as a metadata downgrade downstream.
      // Navigation-layer failures map to orientation admission codes for HTTP.
      let admission: DurableBundleAdmission;
      try {
        const loaded = reconcileDurableAdmission(revision, authority,
          await loadDurableBundleAdmission(db, row.source_revision_ref));
        if (loaded === null) orientationFail("ORIENTATION_SOURCE_NOT_ADMITTED", 403);
        admission = loaded;
      } catch (error) {
        if (error instanceof NavigationError && error.code === "NAVIGATION_ARTIFACT_INVALID") {
          orientationFail("ORIENTATION_ADMISSION_CORRUPT", 503);
        }
        if (error instanceof NavigationError) orientationFail("ORIENTATION_ADMISSION_MISMATCH", 409);
        throw error;
      }
      return { revision, authority, policy, policy_uses: uses(policy),
        policy_closure_ref: policyClosure, title, kind, bundle_admission: admission };
    }));
  }
  async function sources(refs: readonly string[]): Promise<readonly OrientationSource[]> {
    if (refs.length > ORIENTATION_MAX_SOURCES || new Set(refs).size !== refs.length) orientationFail("ORIENTATION_SCOPE_LIMIT", 413);
    refs.forEach(orientationId);
    const currentPolicies = await policies();
    const rows = await all<SourceRow>(`SELECT ${columns} FROM source s JOIN source_revision r ON r.source_id=s.source_id ` +
      "WHERE r.source_revision_ref IN (SELECT value FROM json_each(?1)) ORDER BY r.source_revision_ref LIMIT 65", [JSON.stringify(refs)]);
    if (rows.length !== refs.length) orientationFail("ORIENTATION_SOURCE_DENIED", 403);
    return decode(rows, currentPolicies);
  }
  async function resolveAtom(atom: DeterministicScopeAtom, observedAt: string) {
    const currentPolicies = await policies();
    const filters: string[] = ["r.source_revision_ref=s.head_rev", "r.purge_state='LIVE'",
      "s.source_namespace_id IN (SELECT value FROM json_each(?1))"];
    const binds: Bind[] = [JSON.stringify([...currentPolicies.keys()]), observedAt];
    let project: unknown = null;
    switch (atom.kind) {
      case "GLOBAL_LIBRARY": break;
      case "SELECTED_SOURCES":
        filters.push("s.source_id IN (SELECT value FROM json_each(?3))"); binds.push(JSON.stringify(atom.source_ids)); break;
      case "SOURCE_CLASS": filters.push("s.source_class=?3"); binds.push(atom.source_class); break;
      case "TAG":
        filters.push("EXISTS (SELECT 1 FROM source_tag t WHERE t.source_id=s.source_id AND t.tag=?3 " +
          "AND julianday(t.valid_from)<=julianday(?2) AND (t.valid_to IS NULL OR julianday(t.valid_to)>julianday(?2)))");
        binds.push(atom.tag); break;
      case "PROJECT":
        project = await db.prepare("SELECT project_id, generation, default_disclosure, default_source_policy_ref, " +
          "retention_policy_ref FROM project WHERE project_id=?1").bind(atom.project_id).first();
        if (!project) orientationFail("ORIENTATION_PROJECT_UNAVAILABLE", 404);
        filters.push("EXISTS (SELECT 1 FROM project_source_membership m WHERE m.source_id=s.source_id AND m.project_id=?3 " +
          "AND julianday(m.valid_from)<=julianday(?2) AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?2)))");
        binds.push(atom.project_id); break;
    }
    // ?2 is intentionally present for every atom: all membership predicates share one observation instant.
    filters.push("julianday(?2) IS NOT NULL");
    const rows = await all<SourceRow>(`SELECT ${columns} FROM source s JOIN source_revision r ON r.source_id=s.source_id ` +
      `WHERE ${filters.join(" AND ")} ORDER BY r.source_revision_ref LIMIT 65`, binds);
    if (atom.kind === "SELECTED_SOURCES" && new Set(rows.map((row) => row.source_id)).size !== new Set(atom.source_ids).size) {
      orientationFail("ORIENTATION_SOURCE_DENIED", 403);
    }
    const loaded = await decode(rows, currentPolicies);
    const members = loaded.map((source) => ({ source_revision_ref: source.revision.source_revision_ref,
      source_owner_generation: source.revision.source_owner_generation, policy_closure_ref: source.policy_closure_ref }));
    return { atom_generation_ref: `atom-${await evidenceSha256({ atom, project, members, policies: [...currentPolicies.values()] })}`, members };
  }
  async function resolveAuthorityClosure(request: ScopeAuthorityRequest) {
    const loaded = await sources(request.member_source_revision_refs);
    const policyRows = [...(await policies()).values()];
    if (loaded.some((source) => request.member_policy_closure_refs[source.revision.source_revision_ref] !== source.policy_closure_ref)) {
      orientationFail("ORIENTATION_POLICY_CHANGED", 409);
    }
    const ceilings = [...new Set(loaded.map((source) => source.policy.disclosure_ceiling))];
    if (ceilings.length > 1) orientationFail("ORIENTATION_MIXED_DISCLOSURE", 403);
    const purge = await db.prepare("SELECT COALESCE(MAX(ledger_revision),0) AS revision FROM purge_ledger").first<{ revision: number }>();
    if (!purge || !Number.isSafeInteger(purge.revision) || purge.revision < 0) orientationFail("ORIENTATION_PURGE_UNAVAILABLE", 503);
    return { policy_authority_ref: `policy-${await evidenceSha256({ access, policies: policyRows,
      members: loaded.map((source) => source.policy_closure_ref) })}`,
    disclosure_closure_digest: await evidenceSha256(loaded.map((source) => ({ ref: source.revision.source_revision_ref,
      disclosure: source.policy.disclosure_ceiling, allowed_use: source.policy_uses }))),
    purge_ledger_revision: purge.revision, client_fence_valid: request.client_fence_ref === access.credential_generation,
    denied_source_revision_refs: [] };
  }
  async function grant(snapshot: ScopeSnapshot): Promise<void> {
    const loaded = await sources(snapshot.member_source_revision_refs);
    const allowedUses = [...new Set(loaded.flatMap((source) => source.authority.allowed_use))].sort();
    if (!allowedUses.length) allowedUses.push("research");
    const disclosure = loaded[0]?.policy.disclosure_ceiling ?? "private";
    const policyExpiry = Math.min(...[...(await policies()).values()].map((policy) => Date.parse(policy.expires_at)));
    const expiresAt = new Date(Math.min(Date.parse(snapshot.expires_at), policyExpiry)).toISOString();
    const receipt = `grant-${await evidenceSha256({ scope: snapshot.digest, access })}`;
    const values: Bind[] = [snapshot.snapshot_id, snapshot.revision, access.principal_ref, access.client_class,
      access.credential_generation, snapshot.policy_authority_ref, JSON.stringify(allowedUses), disclosure,
      receipt, expiresAt, clock(), snapshot.digest];
    // Conflict never revives a revoked/expired grant. Currentness is rechecked by the caller on both sides.
    try {
      await db.prepare("INSERT INTO scope_access_grant (snapshot_id,snapshot_revision,principal_ref,client_class," +
        "credential_generation,policy_authority_ref,allowed_use_json,disclosure_ceiling,authorization_receipt_ref,state,expires_at,created_at) " +
        "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,'ACTIVE',?10,?11 FROM scope_snapshot " +
        "WHERE snapshot_id=?1 AND revision=?2 AND snapshot_digest=?12 AND invalidated_at IS NULL " +
        "AND julianday(expires_at)>julianday(?11) ON CONFLICT DO NOTHING").bind(...values).run();
    } catch { /* Reconcile once through exact readback, never retry an ambiguous write. */ }
    const row = await db.prepare("SELECT policy_authority_ref,allowed_use_json,disclosure_ceiling,authorization_receipt_ref,state,expires_at " +
      "FROM scope_access_grant WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3 AND client_class=?4 " +
      "AND credential_generation=?5").bind(...values.slice(0, 5)).first();
    const expected = { policy_authority_ref: snapshot.policy_authority_ref, allowed_use_json: JSON.stringify(allowedUses),
      disclosure_ceiling: disclosure, authorization_receipt_ref: receipt, state: "ACTIVE", expires_at: expiresAt };
    if (!row || canonicalEvidenceJson(row) !== canonicalEvidenceJson(expected)) orientationFail("ORIENTATION_GRANT_UNAVAILABLE", 403);
  }
  return { resolveAtom, resolveAuthorityClosure, sources, grant, requireReadPolicy: async () => { await policies(); } };
}
