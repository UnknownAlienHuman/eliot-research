import { SourceRevisionSchema, type ScopeExpression, type ScopeSnapshot, type SourceRevision } from "@eliotr/contracts";
import {
  canonicalEvidenceJson, evidenceSha256, loadSourceAuthorities, loadScopeAuthority,
  type EvidenceAccessContext, type EvidenceSourceAuthority,
} from "@eliotr/cloudflare-evidence";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { authorizeProjectClientGrant, readClientProjectMembers, type ClientGrantLease } from "./client-grant-authority.js";
import { grantEpoch, grantFail } from "./client-grant-store.js";
import { scopeExpressionAtoms, scopeExpressionIdentity, type DeterministicScopeAtom } from "@eliotr/domain";
import { readOwnerScopeProfile } from "./owner-scope-profile.js";
import { createD1ScopeService } from "./d1-scope-service.js";
import { orientationCurrentness } from "./orientation-currentness.js";
import { issueClientQueryScopeGrant, requireClientScopeProvenance, requireClientArtifactScopeSchema, requireClientScopeSchema, type ClientArtifactScopeOrigin } from "./client-scope-grant.js";
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
}
export interface OwnerScopeAuthority extends Pick<ScopeRepository, "resolveAtom" | "resolveAuthorityClosure"> {
  exhaustiveResolveAtom(atom: DeterministicScopeAtom, observedAt: string): Promise<Awaited<ReturnType<ScopeRepository["resolveAtom"]>>>;
  exhaustiveResolveAuthorityClosure(request: ScopeAuthorityRequest): Promise<Awaited<ReturnType<ScopeRepository["resolveAuthorityClosure"]>>>;
  requireReadPolicy(): Promise<void>;
  sources(refs: readonly string[]): Promise<readonly OrientationSource[]>;
  /**
   * Retrieval-only source loading. Every batch keeps the orientation policy,
   * admission, owner-generation, and purge checks performed by `sources`.
   */
  exhaustiveSources(refs: readonly string[]): Promise<readonly OrientationSource[]>;
  grant(snapshot: ScopeSnapshot, expiresAtCeilingMs?: number): Promise<void>;
  exhaustiveGrant(snapshot: ScopeSnapshot, expiresAtCeilingMs?: number): Promise<void>;
  exhaustiveRequireReadPolicy(): Promise<void>;
}
/** Keep retrieval's larger bound explicit while preserving the orientation batch bound. */
export function splitExhaustiveSourceRefs(refs: readonly string[]): readonly (readonly string[])[] {
  if (refs.length > 4096 || new Set(refs).size !== refs.length) orientationFail("ORIENTATION_SCOPE_LIMIT", 413);
  refs.forEach(orientationId);
  const batches: (readonly string[])[] = [];
  for (let offset = 0; offset < refs.length; offset += ORIENTATION_MAX_SOURCES) {
    batches.push(refs.slice(offset, offset + ORIENTATION_MAX_SOURCES));
  }
  return batches;
}
const columns = "r.source_revision_ref, s.source_id, s.source_namespace_id, s.source_owner_system_id, " +
  "r.source_owner_generation, s.ownership_mode, r.content_sha256, r.object_residency_key_digest, " +
  "r.normalized_artifact_ref, r.captured_at, r.parser_profile_generation, r.quality_state, r.purge_state, " +
  "CASE WHEN length(CAST(s.title AS BLOB))<=4096 THEN s.title ELSE NULL END AS title, s.kind, s.source_class";

/** Read policy is explicit and independent of both Access authentication and ingestion admission. */
export function createOwnerScopeAuthority(db: D1Database, context: EvidenceAccessContext,
  now: () => number = Date.now): OwnerScopeAuthority {
  if (context.client_class !== "owner_pwa") orientationFail("ORIENTATION_OWNER_REQUIRED", 403);
  return createReadPolicyAuthority(db, context, context.principal_ref, now);
}

/** The policy subject is separate from the authenticated actor. Not exported as an impersonation factory. */
function createReadPolicyAuthority(db: D1Database, context: EvidenceAccessContext,
  policyPrincipal: string, now: () => number): OwnerScopeAuthority {
  const access: EvidenceAccessContext = { principal_ref: context.principal_ref,
    client_class: context.client_class, credential_generation: context.credential_generation };
  orientationId(access.principal_ref); orientationId(access.credential_generation); orientationId(policyPrincipal);
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) orientationFail("ORIENTATION_CLOCK_INVALID", 503);
    return new Date(value).toISOString();
  };
  async function all<T>(sql: string, values: Bind[], maximumRows = ORIENTATION_MAX_SOURCES): Promise<T[]> {
    const result = await db.prepare(sql).bind(...values).all<T>();
    if (!result.success || !Array.isArray(result.results)) orientationFail("ORIENTATION_AUTHORITY_UNAVAILABLE", 503, true);
    if (result.results.length > maximumRows) orientationFail("ORIENTATION_SCOPE_LIMIT", 413);
    return result.results;
  }
  async function policies(maximumRows = ORIENTATION_MAX_SOURCES): Promise<Map<string, PolicyRow>> {
    const rows = await all<PolicyRow>("SELECT source_namespace_id, policy_ref, generation, " +
      "CASE WHEN length(CAST(allowed_use_json AS BLOB))<=4096 THEN allowed_use_json ELSE NULL END AS allowed_use_json, " +
      "disclosure_ceiling, expires_at FROM scope_read_policy WHERE principal_ref=?1 AND client_class=?2 " +
      "AND state='ACTIVE' AND julianday(expires_at)>julianday(?3) ORDER BY source_namespace_id LIMIT ?4",
    [policyPrincipal, "owner_pwa", clock(), maximumRows + 1], maximumRows);
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
    const authorities: EvidenceSourceAuthority[] = [];
    for (let offset = 0; offset < rows.length; offset += ORIENTATION_MAX_SOURCES) {
      const batch = rows.slice(offset, offset + ORIENTATION_MAX_SOURCES);
      authorities.push(...await loadSourceAuthorities(db, batch.map((row) => row.source_revision_ref), now()));
    }
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
      return { revision, authority, policy, policy_uses: uses(policy), policy_closure_ref: policyClosure, title, kind };
    }));
  }
  async function sourceBatch(refs: readonly string[], maximumPolicyRows = ORIENTATION_MAX_SOURCES): Promise<readonly OrientationSource[]> {
    if (refs.length > ORIENTATION_MAX_SOURCES || new Set(refs).size !== refs.length) orientationFail("ORIENTATION_SCOPE_LIMIT", 413);
    refs.forEach(orientationId);
    const currentPolicies = await policies(maximumPolicyRows);
    const rows = await all<SourceRow>(`SELECT ${columns} FROM source s JOIN source_revision r ON r.source_id=s.source_id ` +
      "WHERE r.source_revision_ref IN (SELECT value FROM json_each(?1)) ORDER BY r.source_revision_ref LIMIT 65", [JSON.stringify(refs)]);
    if (rows.length !== refs.length) orientationFail("ORIENTATION_SOURCE_DENIED", 403);
    return decode(rows, currentPolicies);
  }
  async function sources(refs: readonly string[]): Promise<readonly OrientationSource[]> {
    if (refs.length > ORIENTATION_MAX_SOURCES || new Set(refs).size !== refs.length) orientationFail("ORIENTATION_SCOPE_LIMIT", 413);
    return sourceBatch(refs, ORIENTATION_MAX_SOURCES);
  }
  async function exhaustiveSources(refs: readonly string[]): Promise<readonly OrientationSource[]> {
    const loaded: OrientationSource[] = [];
    for (const batch of splitExhaustiveSourceRefs(refs)) {
      loaded.push(...await sourceBatch(batch, 4096));
    }
    return loaded.sort((a, b) => a.revision.source_revision_ref < b.revision.source_revision_ref ? -1 : 1);
  }
  async function resolveAtomWithLimit(atom: DeterministicScopeAtom, observedAt: string, maximumSources: number) {
    const currentPolicies = await policies(maximumSources);
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
        project = await db.prepare("SELECT p.project_id, p.generation, p.default_disclosure, p.default_source_policy_ref, " +
          "p.retention_policy_ref FROM project p WHERE p.project_id=?1 AND EXISTS " +
          "(SELECT 1 FROM project_owner po WHERE po.project_id=p.project_id AND po.principal_ref=?2)")
          .bind(atom.project_id, policyPrincipal).first();
        if (!project) orientationFail("ORIENTATION_PROJECT_UNAVAILABLE", 404);
        filters.push("EXISTS (SELECT 1 FROM project_source_membership m WHERE m.source_id=s.source_id AND m.project_id=?3 " +
          "AND julianday(m.valid_from)<=julianday(?2) AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?2)))");
        binds.push(atom.project_id); break;
    }
    // ?2 is intentionally present for every atom: all membership predicates share one observation instant.
    filters.push("julianday(?2) IS NOT NULL");
    const rows = await all<SourceRow>(`SELECT ${columns} FROM source s JOIN source_revision r ON r.source_id=s.source_id ` +
      `WHERE ${filters.join(" AND ")} ORDER BY r.source_revision_ref LIMIT ?${binds.length + 1}`, [...binds, maximumSources + 1], maximumSources);
    if (atom.kind === "SELECTED_SOURCES" && new Set(rows.map((row) => row.source_id)).size !== new Set(atom.source_ids).size) {
      orientationFail("ORIENTATION_SOURCE_DENIED", 403);
    }
    const loaded = await decode(rows, currentPolicies);
    const members = loaded.map((source) => ({ source_revision_ref: source.revision.source_revision_ref,
      source_owner_generation: source.revision.source_owner_generation, policy_closure_ref: source.policy_closure_ref }));
    return { atom_generation_ref: `atom-${await evidenceSha256({ atom, project, members, policies: [...currentPolicies.values()] })}`, members };
  }
  async function resolveAtom(atom: DeterministicScopeAtom, observedAt: string) {
    return resolveAtomWithLimit(atom, observedAt, ORIENTATION_MAX_SOURCES);
  }
  async function exhaustiveResolveAtom(atom: DeterministicScopeAtom, observedAt: string) {
    return resolveAtomWithLimit(atom, observedAt, 4096);
  }
  async function resolveAuthorityClosureWithLoader(
    request: ScopeAuthorityRequest,
    load: (refs: readonly string[]) => Promise<readonly OrientationSource[]>,
    maximumPolicyRows: number,
  ) {
    const loaded = await load(request.member_source_revision_refs);
    const policyRows = [...(await policies(maximumPolicyRows)).values()];
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
  async function resolveAuthorityClosure(request: ScopeAuthorityRequest) {
    return resolveAuthorityClosureWithLoader(request, sources, ORIENTATION_MAX_SOURCES);
  }
  async function exhaustiveResolveAuthorityClosure(request: ScopeAuthorityRequest) {
    return resolveAuthorityClosureWithLoader(request, exhaustiveSources, 4096);
  }
  async function grantWithLoader(
    snapshot: ScopeSnapshot,
    load: (refs: readonly string[]) => Promise<readonly OrientationSource[]>,
    maximumPolicyRows: number,
    expiresAtCeilingMs?: number,
  ): Promise<void> {
    const loaded = await load(snapshot.member_source_revision_refs);
    const allowedUses = [...new Set(loaded.flatMap((source) => source.authority.allowed_use))].sort();
    if (!allowedUses.length) allowedUses.push("research");
    const disclosure = loaded[0]?.policy.disclosure_ceiling ?? "private";
    const policyExpiry = Math.min(...[...(await policies(maximumPolicyRows)).values()].map((policy) => Date.parse(policy.expires_at)));
    if (expiresAtCeilingMs !== undefined && (!Number.isSafeInteger(expiresAtCeilingMs) ||
        expiresAtCeilingMs <= now())) orientationFail("ORIENTATION_OPERATION_EXPIRED", 409);
    const expiresAt = new Date(Math.min(Date.parse(snapshot.expires_at), policyExpiry,
      expiresAtCeilingMs ?? Infinity)).toISOString();
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
  return {
    resolveAtom, exhaustiveResolveAtom, resolveAuthorityClosure, exhaustiveResolveAuthorityClosure, sources, exhaustiveSources,
    grant: (snapshot, expiresAtCeilingMs) => grantWithLoader(snapshot, sources, ORIENTATION_MAX_SOURCES, expiresAtCeilingMs),
    exhaustiveGrant: (snapshot, expiresAtCeilingMs) => grantWithLoader(snapshot, exhaustiveSources, 4096, expiresAtCeilingMs),
    exhaustiveRequireReadPolicy: async () => { await policies(4096); },
    requireReadPolicy: async () => { await policies(); },
  };
}

/** Metadata-only delegation: no scope creation, grants, mutation, paid effects or global resolver escapes. */
export async function createProjectClientCatalogAuthority(db: D1Database, context: AuthenticatedRequestContext,
  projectId: string, now: () => number = Date.now) {
  const lease = await authorizeProjectClientGrant(db, context, { operation: "catalog", project_id: projectId }, now);
  const refs = await readClientProjectMembers(db, projectId, now());
  const members = new Set(refs);
  const shared = createReadPolicyAuthority(db, context, lease.grant.grantor_principal_ref, now);
  // Check ALL requested members. Filtering inaccessible rows out of a full-project request is not authorization.
  await shared.exhaustiveSources(refs);
  await lease.requireCurrent();
  return {
    lease,
    policy_principal_ref: lease.grant.grantor_principal_ref,
    requireReadPolicy: shared.exhaustiveRequireReadPolicy,
    async sources(requested: readonly string[]) {
      if (requested.some((ref) => !members.has(ref))) grantFail("CLIENT_GRANT_SCOPE_DENIED", 403, "Source is outside the delegated project");
      const result = await shared.exhaustiveSources(requested);
      await lease.requireCurrent();
      return result;
    },
  };
}

/** One delegated query scope. Every atom is authorized in full; no project intersection is silently added. */
export async function createProjectClientScopeAuthority(db: D1Database, context: AuthenticatedRequestContext,
  expression: ScopeExpression, now: () => number = Date.now) {
  await requireClientScopeSchema(db);
  const atoms = scopeExpressionAtoms(expression);
  const projects = [...new Set(atoms.flatMap((atom) => atom.kind === "PROJECT" ? [atom.project_id] : []))];
  if (projects.length > 1 || atoms.some((atom) => atom.kind === "GLOBAL_LIBRARY")) {
    grantFail("CLIENT_SCOPE_DENIED", 403, "A delegated query cannot request global or multiple-project authority");
  }
  const lease = await authorizeProjectClientGrant(db, context, { operation: "query",
    ...(projects[0] === undefined ? {} : { project_id: projects[0] }) }, now);
  const projectId = lease.grant.project_id;
  const refs = await readClientProjectMembers(db, projectId, now());
  const members = new Set(refs);
  const identity = scopeExpressionIdentity(expression);
  const shared = createReadPolicyAuthority(db, context, lease.grant.grantor_principal_ref, now);
  const delegation = { grant_id: lease.grant.grant_id, revision: lease.grant.revision,
    project_id: projectId, project_generation: lease.project_generation, operation: "query" };
  const delegationDigest = await evidenceSha256(lease.grant);
  async function requireProject() {
    const epoch = await grantEpoch(db);
    await lease.requireGrantCurrent();
    const current = await readClientProjectMembers(db, projectId, now());
    if (current.length !== members.size || current.some((ref) => !members.has(ref))) {
      grantFail("CLIENT_SCOPE_MEMBERSHIP_CHANGED", 409, "Delegated project membership changed; repeat with a new request", true);
    }
    if (await grantEpoch(db) !== epoch) grantFail("CLIENT_SCOPE_AUTHORITY_CHANGED", 409, "Project authority changed during read", true);
  }
  async function sources(requested: readonly string[]) {
    await requireProject();
    if (requested.some((ref) => !members.has(ref))) grantFail("CLIENT_SCOPE_DENIED", 403, "Source is outside the delegated project");
    const result = await shared.exhaustiveSources(requested);
    await lease.requireGrantCurrent();
    return result;
  }
  async function resolveAtom(atom: DeterministicScopeAtom, observedAt: string) {
    if (atom.kind === "GLOBAL_LIBRARY" || (atom.kind === "PROJECT" && atom.project_id !== projectId)) {
      grantFail("CLIENT_SCOPE_DENIED", 403, "Scope atom is outside the delegated project");
    }
    await requireProject();
    const resolved = await shared.exhaustiveResolveAtom(atom, observedAt);
    if (resolved.members.some((member) => !members.has(member.source_revision_ref)) ||
        (atom.kind === "PROJECT" && resolved.members.length !== members.size)) {
      grantFail("CLIENT_SCOPE_DENIED", 403, "The complete scope atom is not authorized; implicit filtering is forbidden");
    }
    await requireProject();
    return { ...resolved, atom_generation_ref: `client-atom-${await evidenceSha256({
      original: resolved.atom_generation_ref, delegation, delegationDigest })}` };
  }
  async function resolveAuthorityClosure(request: ScopeAuthorityRequest) {
    if (scopeExpressionIdentity(request.expression) !== identity) {
      grantFail("CLIENT_SCOPE_DENIED", 403, "Scope expression does not match this delegated request");
    }
    await sources(request.member_source_revision_refs);
    const closure = await shared.exhaustiveResolveAuthorityClosure(request);
    const policy = `client-policy-${await evidenceSha256({ original: closure.policy_authority_ref, delegation, delegationDigest })}`;
    await requireProject();
    return { ...closure, policy_authority_ref: policy };
  }
  const authority: OwnerScopeAuthority = {
    resolveAtom, exhaustiveResolveAtom: resolveAtom,
    resolveAuthorityClosure, exhaustiveResolveAuthorityClosure: resolveAuthorityClosure,
    requireReadPolicy: async () => { await requireProject(); await shared.exhaustiveRequireReadPolicy(); },
    exhaustiveRequireReadPolicy: async () => { await requireProject(); await shared.exhaustiveRequireReadPolicy(); },
    sources, exhaustiveSources: sources,
    grant: issue, exhaustiveGrant: issue,
  };
  // Same scope algorithm and clock frontier as the owner, with the grantor policy subject kept separate.
  const scopes = createD1ScopeService(db, authority, { now, max_snapshot_members: 4096, preserve_resolution_errors: true });
  const current = orientationCurrentness(db, scopes, lease.grant.grantor_principal_ref, now);
  async function issue(snapshot: ScopeSnapshot, expiresAtCeilingMs?: number) {
    await issueClientQueryScopeGrant({ database: db, context, snapshot, lease,
      sources: () => sources(snapshot.member_source_revision_refs), require_current: current, now,
      ...(expiresAtCeilingMs === undefined ? {} : { expires_at_ceiling_ms: expiresAtCeilingMs }) });
  }
  async function requireScopeCurrent(snapshot: ScopeSnapshot) {
    await lease.requireGrantCurrent();
    await current(snapshot);
    await requireClientScopeProvenance(db, context, snapshot, lease);
  }
  await lease.requireCurrent();
  return { authority, requireScopeCurrent };
}

/** Read every original source under the current project and grantor policy.
 * The authenticated service remains distinct from the policy subject. */
function projectHistoricalSources(
  db: D1Database, shared: OwnerScopeAuthority, lease: ClientGrantLease,
  requireOrigin: () => Promise<void>, now: () => number,
) {
  return async (refs: readonly string[]) => {
    const epoch = await grantEpoch(db);
    await requireOrigin();
    // Validate every historical source ID against today's membership without adopting its new head.
    for (const batch of splitExhaustiveSourceRefs(refs)) {
      const rows = await db.prepare("SELECT sr.source_revision_ref FROM source_revision sr " +
        "JOIN project_source_membership m ON m.source_id=sr.source_id AND m.project_id=?1 " +
        "WHERE sr.source_revision_ref IN (SELECT value FROM json_each(?2)) " +
        "AND julianday(m.valid_from)<=julianday(?3) AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?3)) " +
        "ORDER BY sr.source_revision_ref LIMIT ?4")
        .bind(lease.grant.project_id, JSON.stringify(batch), new Date(now()).toISOString(), batch.length + 1)
        .all<{ source_revision_ref: string }>();
      const expected = new Set(batch);
      if (!rows.success || !Array.isArray(rows.results) || rows.results.length !== batch.length ||
          rows.results.some((row) => !expected.delete(row.source_revision_ref)) || expected.size !== 0) {
        grantFail("CLIENT_ARTIFACT_SOURCE_DENIED", 403, "Historical sources are not all current project members");
      }
    }
    const result = await shared.exhaustiveSources(refs);
    await requireOrigin();
    if (await grantEpoch(db) !== epoch) grantFail("CLIENT_ARTIFACT_AUTHORITY_CHANGED", 409, "Historical read authority changed during read", true);
    return result;
  };
}

/** Historical report reads keep the service actor and the grantor's policy subject separate.
 * Only reports originally scoped to this explicit project are shareable; overlapping sources
 * do not authorize a global, another project's, or another owner's report. */
export async function createProjectClientArtifactAuthority(
  db: D1Database, context: AuthenticatedRequestContext, original: ScopeSnapshot,
  origin: ClientArtifactScopeOrigin,
  originalPrincipal: string, now: () => number = Date.now,
) {
  if (original.resolved_scope_expression.kind !== "PROJECT") {
    grantFail("CLIENT_ARTIFACT_PROJECT_REQUIRED", 403, "Report must originate from one explicit project");
  }
  await requireClientArtifactScopeSchema(db);
  const projectId = original.resolved_scope_expression.project_id;
  const lease = await authorizeProjectClientGrant(db, context, { operation: origin.operation, project_id: projectId }, now);
  if (lease.grant.grantor_principal_ref !== originalPrincipal || !lease.grant.allowed_operations.includes("report")) {
    grantFail("CLIENT_ARTIFACT_DENIED", 403, "Delegation does not authorize this report's owner");
  }
  const shared = createReadPolicyAuthority(db, context, originalPrincipal, now);
  async function requireOrigin() {
    await lease.requireGrantCurrent();
    const row = await db.prepare("SELECT 1 AS present FROM artifact_draft_binding b " +
      "JOIN artifact_revision a ON a.artifact_id=b.artifact_id AND a.revision=b.revision " +
      "WHERE b.artifact_id=?1 AND b.revision=?2 AND b.principal_ref=?3 " +
      "AND b.scope_snapshot_id=?4 AND b.scope_snapshot_revision=?5 AND a.status='DRAFT' LIMIT 1")
      .bind(origin.artifact_ref.id, origin.artifact_ref.revision, originalPrincipal, original.snapshot_id, original.revision).first();
    if (row === null) grantFail("CLIENT_ARTIFACT_DENIED", 403, "Saved report binding is unavailable");
    await lease.requireGrantCurrent();
  }
  const sources = projectHistoricalSources(db, shared, lease, requireOrigin, now);
  async function resolveAtom(atom: DeterministicScopeAtom, observedAt: string) {
    if (atom.kind !== "PROJECT" || atom.project_id !== projectId) grantFail("CLIENT_ARTIFACT_DENIED", 403, "Report project differs");
    await requireOrigin();
    const result = await shared.exhaustiveResolveAtom(atom, observedAt);
    await requireOrigin();
    return result;
  }
  async function resolveAuthorityClosure(request: ScopeAuthorityRequest) {
    if (scopeExpressionIdentity(request.expression) !== scopeExpressionIdentity(original.resolved_scope_expression)) {
      grantFail("CLIENT_ARTIFACT_DENIED", 403, "Report expression differs");
    }
    await sources(request.member_source_revision_refs);
    const closure = await shared.exhaustiveResolveAuthorityClosure(request);
    const policy = `client-report-${await evidenceSha256({ original: closure.policy_authority_ref,
      scope: original.digest, artifact: origin, grant: lease.grant, project_generation: lease.project_generation })}`;
    await requireOrigin();
    return { ...closure, policy_authority_ref: policy };
  }
  const requireReadPolicy = async () => { await requireOrigin(); await shared.exhaustiveRequireReadPolicy(); };
  const noUnboundGrant = async (): Promise<never> => grantFail("CLIENT_ARTIFACT_DENIED", 403, "Artifact-bound grant issuance is required");
  const authority: OwnerScopeAuthority = { sources, exhaustiveSources: sources, resolveAtom, exhaustiveResolveAtom: resolveAtom,
    resolveAuthorityClosure, exhaustiveResolveAuthorityClosure: resolveAuthorityClosure,
    requireReadPolicy, exhaustiveRequireReadPolicy: requireReadPolicy, grant: noUnboundGrant, exhaustiveGrant: noUnboundGrant };
  await requireOrigin();
  return { authority, lease, requireOrigin };
}

/** Read-only authority for an existing owner-authored explicit-project run.
 * Stored credentials identify provenance, never the caller or execution rights.
 * The caller must also validate the original snapshot's historical currentness. */
export async function createProjectClientRunReadAuthority(
  db: D1Database, context: AuthenticatedRequestContext, operationId: string,
  now: () => number = Date.now,
) {
  const lease = await authorizeProjectClientGrant(db, context, { operation: "status" }, now);
  const binding = await db.prepare("SELECT investigation_id, principal_ref, credential_generation, " +
    "deployment_generation, handler_generation, scope_snapshot_id, scope_snapshot_revision, policy_authority_ref, " +
    "authorization_receipt_ref FROM research_workflow_run r WHERE operation_id=?1 AND principal_ref=?2 " +
    "AND EXISTS (SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id=r.scope_snapshot_id " +
    "AND s.revision=r.scope_snapshot_revision AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT' " +
    "AND json_extract(s.resolved_scope_expression_json,'$.project_id')=?3) LIMIT 1")
    .bind(orientationId(operationId), lease.grant.grantor_principal_ref, lease.grant.project_id).first<{
      investigation_id: string; principal_ref: string; credential_generation: string;
      deployment_generation: string; handler_generation: string; scope_snapshot_id: string;
      scope_snapshot_revision: number; policy_authority_ref: string; authorization_receipt_ref: string;
    }>();
  if (binding === null) { await lease.requireCurrent(); return null; }
  for (const value of [binding.investigation_id, binding.principal_ref, binding.credential_generation,
    binding.deployment_generation, binding.handler_generation, binding.scope_snapshot_id,
    binding.policy_authority_ref, binding.authorization_receipt_ref]) orientationId(value);
  if (!Number.isSafeInteger(binding.scope_snapshot_revision) || binding.scope_snapshot_revision < 1) {
    grantFail("CLIENT_RUN_ORIGIN_INVALID", 409, "Saved run identity is inconsistent");
  }
  const ref = { id: binding.scope_snapshot_id, revision: binding.scope_snapshot_revision };
  const persisted = await loadScopeAuthority(db, ref);
  const original = persisted?.snapshot;
  if (!original || original.resolved_scope_expression.kind !== "PROJECT" ||
      original.resolved_scope_expression.project_id !== lease.grant.project_id ||
      original.client_fence_ref !== binding.credential_generation ||
      original.policy_authority_ref !== binding.policy_authority_ref) {
    grantFail("CLIENT_RUN_DENIED", 403, "Run does not originate from this delegated project");
  }
  await readOwnerScopeProfile(db, original);
  const shared = createReadPolicyAuthority(db, context, binding.principal_ref, now);
  const requireOrigin = async () => {
    await lease.requireGrantCurrent();
    const row = await db.prepare("SELECT 1 AS present FROM research_workflow_run r JOIN scope_access_grant g " +
      "ON g.snapshot_id=r.scope_snapshot_id AND g.snapshot_revision=r.scope_snapshot_revision " +
      "AND g.principal_ref=r.principal_ref AND g.credential_generation=r.credential_generation " +
      "AND g.authorization_receipt_ref=r.authorization_receipt_ref AND g.policy_authority_ref=r.policy_authority_ref " +
      "WHERE r.operation_id=?1 AND r.investigation_id=?2 AND r.principal_ref=?3 AND r.credential_generation=?4 " +
      "AND r.deployment_generation=?5 AND r.handler_generation=?6 AND r.scope_snapshot_id=?7 " +
      "AND r.scope_snapshot_revision=?8 AND r.policy_authority_ref=?9 AND r.authorization_receipt_ref=?10 " +
      "AND g.client_class='owner_pwa' AND g.project_client_grant_id IS NULL AND g.state IN ('ACTIVE','EXPIRED') " +
      "AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research') " +
      "AND NOT EXISTS (SELECT 1 FROM scope_access_grant old WHERE old.snapshot_id=g.snapshot_id " +
      "AND old.snapshot_revision=g.snapshot_revision AND old.principal_ref=g.principal_ref " +
      "AND old.client_class='owner_pwa' AND old.state='REVOKED') LIMIT 1")
      .bind(operationId, binding.investigation_id, binding.principal_ref, binding.credential_generation,
        binding.deployment_generation, binding.handler_generation, ref.id, ref.revision,
        binding.policy_authority_ref, binding.authorization_receipt_ref).first();
    if (row === null) grantFail("CLIENT_RUN_DENIED", 403, "Original run authority was revoked or changed");
    await lease.requireGrantCurrent();
  };
  const sources = projectHistoricalSources(db, shared, lease, requireOrigin, now);
  const requireCurrent = async () => {
    const epoch = await grantEpoch(db);
    const loaded = await sources(original.member_source_revision_refs);
    if (loaded.some((source) => original.source_owner_generations[source.revision.source_revision_ref] !==
        source.revision.source_owner_generation) || new Set(loaded.map((source) => source.revision.source_id)).size !== loaded.length) {
      grantFail("CLIENT_RUN_SOURCE_DENIED", 403, "Historical source ownership is inconsistent");
    }
    const closure = await shared.exhaustiveResolveAuthorityClosure({
      expression: original.resolved_scope_expression, canonical_expression: scopeExpressionIdentity(original.resolved_scope_expression),
      member_source_revision_refs: original.member_source_revision_refs,
      member_policy_closure_refs: Object.fromEntries(loaded.map((source) => [source.revision.source_revision_ref, source.policy_closure_ref])),
      observed_at: new Date(now()).toISOString(), client_fence_ref: context.credential_generation,
    });
    if (!closure.client_fence_valid || closure.denied_source_revision_refs.length !== 0 ||
        closure.disclosure_closure_digest !== original.disclosure_closure_digest ||
        closure.purge_ledger_revision < original.purge_ledger_revision) {
      grantFail("CLIENT_RUN_SOURCE_DENIED", 403, "Current disclosure does not cover the original run");
    }
    await requireOrigin();
    if (await grantEpoch(db) !== epoch) grantFail("CLIENT_RUN_AUTHORITY_CHANGED", 409, "Run read authority changed", true);
  };
  await lease.requireCurrent();
  return { binding: Object.freeze(binding), original, lease, requireCurrent };
}
