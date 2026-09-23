import type { ProjectClientGrant, ProjectClientOperation } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { findClientGrant, grantEpoch, grantFail, grantId, grantNow, grantRead, readClientGrant, requireGrantOwner } from "./client-grant-store.js";

/** Grant locators never authenticate. Read only the identity produced by the Access verifier. */
function verifiedService(context: AuthenticatedRequestContext, now: number) {
  const identity = context.access;
  if (context.client_class !== "trusted_agent" && context.client_class !== "named_api_client") {
    grantFail("CLIENT_GRANT_SERVICE_REQUIRED", 403, "A verified service identity is required");
  }
  if (!identity || identity.authentication_method !== "service_token" || !identity.issuer ||
      identity.principal_ref !== context.principal_ref || identity.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(identity.expires_at)) || Date.parse(identity.expires_at) <= now || context.request.signal.aborted) {
    grantFail("CLIENT_GRANT_IDENTITY_INVALID", 403, "Service identity is missing, expired or inconsistent");
  }
  return { issuer: identity.issuer, authentication_method: "service_token" as const, subject: identity.principal_ref };
}

export async function requireClientGrantNamespaces(db: D1Database, principal: string, namespaces: readonly string[]): Promise<void> {
  if (namespaces.length > 64 || new Set(namespaces).size !== namespaces.length) {
    grantFail("CLIENT_GRANT_NAMESPACE_DENIED", 403, "Import namespace set is invalid");
  }
  if (!namespaces.length) return;
  const row = await grantRead(() => db.prepare("SELECT COUNT(*) AS count FROM source_namespace_ownership o " +
    "JOIN source_admission_policy p ON p.source_namespace_id=o.source_namespace_id AND p.revision=o.source_admission_policy_revision " +
    "WHERE o.status='ACTIVE' AND o.source_namespace_id IN (SELECT value FROM json_each(?1)) " +
    "AND json_type(p.authorized_principal_refs_json)='array' AND EXISTS " +
    "(SELECT 1 FROM json_each(p.authorized_principal_refs_json) a WHERE a.type='text' AND a.value=?2) " +
    "AND EXISTS (SELECT 1 FROM json_each(p.allowed_ownership_modes_json) m WHERE m.value IN ('immutable_import','erc_owned','ownership_cutover'))")
    .bind(JSON.stringify(namespaces), principal).first<{ count: number }>());
  if (row?.count !== namespaces.length) {
    grantFail("CLIENT_GRANT_NAMESPACE_DENIED", 403, "Grantor lacks current admission authority for a requested namespace");
  }
}

/** Metadata only; a caller requesting a project is never silently given its first page as its scope. */
export async function readClientProjectMembers(db: D1Database, project: string, now: number): Promise<readonly string[]> {
  const rows = await grantRead(() => db.prepare("SELECT m.source_id,s.head_rev FROM project_source_membership m " +
    "LEFT JOIN source s ON s.source_id=m.source_id WHERE m.project_id=?1 AND julianday(m.valid_from)<=julianday(?2) " +
    "AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?2)) ORDER BY m.source_id LIMIT 4097")
    .bind(project, new Date(now).toISOString()).all<{ source_id: string; head_rev: string | null }>());
  if (!rows.success || !Array.isArray(rows.results)) grantFail("CLIENT_GRANT_STORAGE_UNAVAILABLE", 503, "Project membership is unavailable", true);
  if (rows.results.length > 4096) grantFail("CLIENT_GRANT_SCOPE_LIMIT", 413, "Project exceeds the current bounded metadata envelope");
  const refs = rows.results.map((row) => {
    if (row.head_rev === null) grantFail("CLIENT_GRANT_SOURCE_DENIED", 403, "A project member has no authorized source revision");
    return grantId(row.head_rev);
  });
  if (new Set(refs).size !== refs.length) grantFail("CLIENT_GRANT_SOURCE_DENIED", 403, "Project membership is ambiguous");
  return Object.freeze(refs);
}

export interface ClientGrantLease {
  readonly grant: ProjectClientGrant;
  readonly authority_epoch: number;
  readonly project_generation: number;
  readonly expires_at_ms: number;
  requireCurrent(): Promise<void>;
  /** Revalidate the same grant after our own scope writes; caller must also validate its frozen scope. */
  requireGrantCurrent(): Promise<void>;
}
/** Delegation check only. Each consumer must additionally authorize its exact scope and effects. */
export async function authorizeProjectClientGrant(db: D1Database, context: AuthenticatedRequestContext,
  input: { readonly operation: ProjectClientOperation; readonly project_id?: string; readonly required_revision?: number;
    readonly ingest_namespace_id?: string }, now: () => number = Date.now): Promise<ClientGrantLease> {
  const started = grantNow(now);
  const actor = verifiedService(context, started);
  const epoch = await grantEpoch(db);
  const locator = context.request.headers.get("X-Eliotr-Client-Grant");
  const projectId = input.project_id === undefined ? undefined : grantId(input.project_id);
  if (projectId === undefined && locator === null) grantFail("CLIENT_GRANT_SCOPE_REQUIRED", 403, "One explicit project or grant locator is required");
  const grant = locator !== null ? await readClientGrant(db, grantId(locator)) : await findClientGrant(db, projectId ?? "", actor);
  if (!grant || grant.state !== "ACTIVE" || (projectId !== undefined && grant.project_id !== projectId) ||
      canonicalJson(grant.grantee) !== canonicalJson(actor) || !grant.allowed_operations.includes(input.operation) ||
      (input.required_revision !== undefined && grant.revision !== input.required_revision) || Date.parse(grant.expires_at) <= started) {
    grantFail("CLIENT_GRANT_DENIED", 403, "No current delegation authorizes this actor, project and operation");
  }
  const generation = await requireGrantOwner(db, grant.project_id, grant.grantor_principal_ref);
  const record = canonicalJson(grant);
  const expires = Math.min(Date.parse(grant.expires_at), Date.parse(context.access?.expires_at ?? ""));
  const namespace = input.ingest_namespace_id;
  if (input.operation === "ingest.bundle" || input.operation === "workspace.admit") {
    if (namespace === undefined || !grant.ingest_namespace_ids.includes(grantId(namespace))) {
      grantFail("CLIENT_GRANT_NAMESPACE_DENIED", 403, "Import requires one explicitly granted namespace");
    }
    await requireClientGrantNamespaces(db, grant.grantor_principal_ref, [namespace]);
  } else if (namespace !== undefined) {
    grantFail("CLIENT_GRANT_INPUT_INVALID", 400, "Import namespace is not a read scope");
  }
  const requireGrantCurrent = async () => {
    const instant = grantNow(now);
    if (instant < started || instant >= expires) grantFail("CLIENT_GRANT_DENIED", 403, "Delegation or service session expired");
    verifiedService(context, instant);
    const current = await readClientGrant(db, grant.grant_id);
    if (!current || canonicalJson(current) !== record || await requireGrantOwner(db, grant.project_id, grant.grantor_principal_ref) !== generation) {
      grantFail("CLIENT_GRANT_AUTHORITY_CHANGED", 409, "Delegation or project authority changed", true);
    }
    if (namespace !== undefined) await requireClientGrantNamespaces(db, grant.grantor_principal_ref, [namespace]);
    if (grantNow(now) >= expires || context.request.signal.aborted) grantFail("CLIENT_GRANT_DENIED", 403, "Delegation expired or request was cancelled");
  };
  const requireCurrent = async () => {
    await requireGrantCurrent();
    if (await grantEpoch(db) !== epoch) grantFail("CLIENT_GRANT_AUTHORITY_CHANGED", 409, "Delegation or upstream authority changed; restart the read", true);
    if (grantNow(now) >= expires || context.request.signal.aborted) grantFail("CLIENT_GRANT_DENIED", 403, "Delegation expired or request was cancelled");
  };
  await requireCurrent();
  return { grant, authority_epoch: epoch, project_generation: generation, expires_at_ms: expires, requireCurrent, requireGrantCurrent };
}
