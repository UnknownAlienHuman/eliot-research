import type { ScopeSnapshot } from "@eliotr/contracts";
import type { EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ClientGrantLease } from "./client-grant-authority.js";
import { grantEpoch, grantFail, grantNow, grantRead } from "./client-grant-store.js";
import { nextOrientationBoundary } from "./orientation-currentness.js";
import type { OrientationSource } from "./orientation-authority.js";

const GENERATION = "project-client-scope-v1";
export async function requireClientScopeSchema(db: D1Database): Promise<void> {
  const row = await grantRead(() => db.prepare("SELECT value FROM schema_state WHERE key='project_client_scope_generation'")
    .first<{ value: string }>());
  if (row?.value !== GENERATION) {
    grantFail("CLIENT_SCOPE_NOT_READY", 503, "Delegated query scopes require migration 0073", true);
  }
}

const provenance = (lease: ClientGrantLease) => ({
  project_client_grant_id: lease.grant.grant_id,
  project_client_grant_revision: lease.grant.revision,
  project_client_operation: "query",
  project_client_project_generation: lease.project_generation,
});

/** Scope authority is an exact derivative of one delegation revision, not today's replacement grant. */
export async function requireClientScopeProvenance(db: D1Database, access: EvidenceAccessContext,
  scope: ScopeSnapshot, lease: ClientGrantLease): Promise<void> {
  const row = await grantRead(() => db.prepare("SELECT project_client_grant_id,project_client_grant_revision," +
    "project_client_operation,project_client_project_generation FROM scope_access_grant_effective " +
    "WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3 AND client_class=?4 AND credential_generation=?5 " +
    "AND state='ACTIVE' AND policy_authority_ref=?6 AND julianday(expires_at)>julianday('now')")
    .bind(scope.snapshot_id, scope.revision, access.principal_ref, access.client_class,
      access.credential_generation, scope.policy_authority_ref).first());
  if (row === null || canonicalEvidenceJson(row) !== canonicalEvidenceJson(provenance(lease))) {
    grantFail("CLIENT_SCOPE_AUTHORITY_STALE", 403, "The frozen scope is not authorized by this delegation revision");
  }
  await lease.requireGrantCurrent();
}

/** Issue into the existing exact-scope grant store. No browser identity or owner authority is substituted. */
export async function issueClientQueryScopeGrant(input: {
  readonly database: D1Database;
  readonly context: AuthenticatedRequestContext;
  readonly snapshot: ScopeSnapshot;
  readonly lease: ClientGrantLease;
  readonly sources: () => Promise<readonly OrientationSource[]>;
  readonly require_current: (snapshot: ScopeSnapshot) => Promise<ScopeSnapshot>;
  readonly expires_at_ceiling_ms?: number;
  readonly now: () => number;
}): Promise<void> {
  const { database: db, context, snapshot, lease, now } = input;
  const started = grantNow(now);
  const epoch = await grantEpoch(db);
  await lease.requireGrantCurrent();
  await input.require_current(snapshot);
  const loaded = await input.sources();
  const disclosures = new Set(loaded.map((source) => source.policy.disclosure_ceiling));
  if (disclosures.size > 1 || loaded.some((source) => !source.policy_uses.includes("research") ||
      !source.authority.allowed_use.includes("research"))) {
    grantFail("CLIENT_SCOPE_USE_DENIED", 403, "Query disclosure or source-use authority is inconsistent");
  }
  // Membership's next boundary belongs to the delegated project even for a SELECTED_SOURCES request.
  const boundary = await nextOrientationBoundary(db, lease.grant.grantor_principal_ref, {
    resolved_scope_expression: { kind: "PROJECT", project_id: lease.grant.project_id },
    member_source_revision_refs: snapshot.member_source_revision_refs, expires_at: snapshot.expires_at,
  }, started);
  const ceiling = input.expires_at_ceiling_ms ?? Infinity;
  if (input.expires_at_ceiling_ms !== undefined && !Number.isSafeInteger(ceiling)) {
    grantFail("CLIENT_SCOPE_INPUT_INVALID", 400, "Scope deadline is invalid");
  }
  const expires = Math.min(boundary, lease.expires_at_ms, ceiling,
    ...loaded.flatMap((source) => [Date.parse(source.policy.expires_at),
      source.authority.admission_expires_at === undefined ? Infinity : Date.parse(source.authority.admission_expires_at)]));
  if (!Number.isSafeInteger(expires) || expires <= grantNow(now) || context.request.signal.aborted) {
    grantFail("CLIENT_SCOPE_AUTHORITY_STALE", 403, "Scope authority expired or the query was cancelled");
  }
  const access: EvidenceAccessContext = { principal_ref: context.principal_ref, client_class: context.client_class,
    credential_generation: context.credential_generation };
  const origin = provenance(lease);
  const receipt = `grant-${await evidenceSha256({ scope: snapshot.digest, access, delegation: origin })}`;
  // Preserve the resolver's source-use closure, as on owner scopes. These are source-purpose
  // labels, not client operations or permission to spend; the origin remains query-only.
  const allowedUses = [...new Set(loaded.flatMap((source) => source.authority.allowed_use))].sort();
  if (!allowedUses.length) allowedUses.push("research");
  if (allowedUses.length > 512) grantFail("CLIENT_SCOPE_USE_DENIED", 403, "Source-use closure exceeds the evidence envelope");
  const expected = { policy_authority_ref: snapshot.policy_authority_ref, allowed_use_json: JSON.stringify(allowedUses),
    disclosure_ceiling: loaded[0]?.policy.disclosure_ceiling ?? "private", authorization_receipt_ref: receipt,
    state: "ACTIVE", expires_at: new Date(expires).toISOString(), ...origin };
  await lease.requireGrantCurrent();
  if (grantNow(now) < started || grantNow(now) >= expires || context.request.signal.aborted) {
    grantFail("CLIENT_SCOPE_AUTHORITY_STALE", 403, "Scope authority changed before issue");
  }
  try {
    await db.prepare("INSERT INTO scope_access_grant (snapshot_id,snapshot_revision,principal_ref,client_class," +
      "credential_generation,policy_authority_ref,allowed_use_json,disclosure_ceiling,authorization_receipt_ref,state," +
      "expires_at,created_at,project_client_grant_id,project_client_grant_revision,project_client_operation," +
      "project_client_project_generation,project_client_authority_epoch) " +
      "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,'ACTIVE',?10,?11,?12,?13,'query',?14,?15 FROM scope_snapshot s " +
      "WHERE s.snapshot_id=?1 AND s.revision=?2 AND s.snapshot_digest=?16 AND s.invalidated_at IS NULL " +
      "AND julianday(?10)>julianday('now') " +
      "AND (SELECT generation FROM orientation_authority_epoch WHERE singleton=1)=?15 ON CONFLICT DO NOTHING")
      .bind(snapshot.snapshot_id, snapshot.revision, access.principal_ref, access.client_class, access.credential_generation,
        snapshot.policy_authority_ref, expected.allowed_use_json, expected.disclosure_ceiling, receipt, expected.expires_at,
        new Date(started).toISOString(), origin.project_client_grant_id, origin.project_client_grant_revision,
        origin.project_client_project_generation, epoch, snapshot.digest).run();
  } catch { /* An ambiguous write is read back once; it is never retried with a new identity. */ }
  const settled = await grantRead(() => db.prepare("SELECT policy_authority_ref,allowed_use_json,disclosure_ceiling," +
    "authorization_receipt_ref,state,expires_at,project_client_grant_id,project_client_grant_revision," +
    "project_client_operation,project_client_project_generation FROM scope_access_grant " +
    "WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3 AND client_class=?4 AND credential_generation=?5")
    .bind(snapshot.snapshot_id, snapshot.revision, access.principal_ref, access.client_class, access.credential_generation).first());
  if (settled === null) {
    if (await grantEpoch(db) !== epoch) grantFail("CLIENT_SCOPE_AUTHORITY_CHANGED", 409, "Authority changed before scope issue", true);
    grantFail("CLIENT_SCOPE_SETTLEMENT_UNCERTAIN", 503, "Scope grant could not be confirmed", true);
  }
  if (canonicalEvidenceJson(settled) !== canonicalEvidenceJson(expected)) {
    grantFail("CLIENT_SCOPE_AUTHORITY_STALE", 403, "An existing scope grant cannot be replaced or revived");
  }
  await input.require_current(snapshot);
  await requireClientScopeProvenance(db, access, snapshot, lease);
}
