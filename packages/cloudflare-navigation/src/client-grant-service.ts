import { ProjectClientGrantPutSchema, ProjectClientGrantRevokeSchema, ProjectClientGrantSchema,
  type ProjectClientGrant, type ProjectClientGrantList, type ProjectClientGrantPut } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { createOwnerScopeAuthority } from "./orientation-authority.js";
import { readClientProjectMembers, requireClientGrantNamespaces } from "./client-grant-authority.js";
import { CLIENT_GRANT_MAX_BYTES, findClientGrant, grantEpoch, grantFail, grantId, grantNow, readClientGrant,
  readClientGrantPage, readGrantReplay, readClientGrantSpend, type ClientGrantSpendBinding, requireGrantOwner } from "./client-grant-store.js";

export interface ClientGrantServiceOptions {
  readonly database: D1Database;
  readonly trusted_issuers: readonly string[];
  readonly now?: () => number;
  /** Composition validates the installed operator approval, never a policy locator alone. */
  readonly authorize_spend?: (context: AuthenticatedRequestContext, input: ProjectClientGrantPut) => Promise<ClientGrantSpendBinding>;
}

/** Owner issuance and revocation share one append-only receipt/authority table. */
export function createProjectClientGrantService(options: ClientGrantServiceOptions) {
  const db = options.database; const now = options.now ?? Date.now;
  const issuers = new Set(options.trusted_issuers);
  function owner(context: AuthenticatedRequestContext): string {
    if (context.client_class !== "owner_pwa" || context.request.signal.aborted) {
      grantFail("CLIENT_GRANT_OWNER_REQUIRED", 403, "A current owner request is required");
    }
    if (context.access && (context.access.principal_ref !== context.principal_ref ||
        context.access.credential_generation !== context.credential_generation ||
        !Number.isFinite(Date.parse(context.access.expires_at)) || Date.parse(context.access.expires_at) <= grantNow(now))) {
      grantFail("CLIENT_GRANT_OWNER_REQUIRED", 403, "Owner session is no longer current");
    }
    return grantId(context.principal_ref);
  }
  async function list(context: AuthenticatedRequestContext, project: string, after = ""): Promise<ProjectClientGrantList> {
    const principal = owner(context); const projectId = grantId(project);
    if (after !== "") grantId(after);
    const epoch = await grantEpoch(db);
    await requireGrantOwner(db, projectId, principal);
    const grants = await readClientGrantPage(db, projectId, after);
    await requireGrantOwner(db, projectId, owner(context));
    if (await grantEpoch(db) !== epoch) grantFail("CLIENT_GRANT_AUTHORITY_CHANGED", 409, "Project changed during grant listing", true);
    owner(context);
    return { protocol: "eliotr.project-client-grants.v1", grants: grants.slice(0, 20),
      ...(grants.length > 20 ? { next_grant_id: grants[19]?.grant_id ?? "" } : {}) };
  }
  async function mutate(context: AuthenticatedRequestContext, project: string, rawGrant: string,
    rawInput: unknown, operation: "PUT" | "DELETE"): Promise<ProjectClientGrant> {
    const principal = owner(context); const projectId = grantId(project); const grantIdValue = grantId(rawGrant);
    const key = grantId(context.request.headers.get("Idempotency-Key"));
    const parsed = operation === "PUT" ? ProjectClientGrantPutSchema.safeParse(rawInput) : ProjectClientGrantRevokeSchema.safeParse(rawInput);
    if (!parsed.success) grantFail("CLIENT_GRANT_INPUT_INVALID", 400, "Grant mutation contains unknown or invalid fields");
    const normalized = operation === "PUT" ? (() => {
      const input = ProjectClientGrantPutSchema.parse(parsed.data);
      if (new Set(input.allowed_operations).size !== input.allowed_operations.length ||
          new Set(input.ingest_namespace_ids).size !== input.ingest_namespace_ids.length) {
        grantFail("CLIENT_GRANT_INPUT_INVALID", 400, "Grant operations and namespaces must be unique");
      }
      return { ...input, allowed_operations: [...input.allowed_operations].sort(),
        ingest_namespace_ids: [...input.ingest_namespace_ids].sort(), expires_at: new Date(input.expires_at).toISOString() };
    })() : parsed.data;
    const requestDigest = await sha256Utf8(canonicalJson({ protocol: "eliotr.project-client-grant-mutation.v1",
      operation, project_id: projectId, grant_id: grantIdValue, grantor_principal_ref: principal, input: normalized }));
    await requireGrantOwner(db, projectId, principal);
    const replay = await readGrantReplay(db, principal, key, requestDigest);
    if (replay) { await requireGrantOwner(db, projectId, owner(context)); owner(context); return replay; }
    const epoch = await grantEpoch(db);
    const generation = await requireGrantOwner(db, projectId, principal);
    const previous = await readClientGrant(db, grantIdValue);
    const expected = parsed.data.expected_revision;
    if (previous && (previous.project_id !== projectId || previous.grantor_principal_ref !== principal)) {
      grantFail("CLIENT_GRANT_DENIED", 403, "Grant does not belong to this owner and project");
    }
    if ((previous?.revision ?? 0) !== expected || (operation === "DELETE" && previous === null)) {
      grantFail("CLIENT_GRANT_REVISION_CONFLICT", 409, "Grant revision changed");
    }
    const instant = grantNow(now); const timestamp = new Date(instant).toISOString();
    let authorityDeadline = context.access ? Date.parse(context.access.expires_at) : instant + 30_000;
    let result: ProjectClientGrant;
    let sponsorship: ClientGrantSpendBinding | null = null;
    if (operation === "PUT") {
      const input = ProjectClientGrantPutSchema.parse(normalized);
      if (!issuers.has(input.grantee.issuer)) grantFail("CLIENT_GRANT_ISSUER_DENIED", 403, "Grantee issuer is not a configured Access issuer");
      if (previous && canonicalJson(input.grantee) !== canonicalJson(previous.grantee)) {
        grantFail("CLIENT_GRANT_IDENTITY_CONFLICT", 409, "A grant cannot be reassigned to another identity");
      }
      const sameActor = await findClientGrant(db, projectId, input.grantee);
      if (sameActor && sameActor.grant_id !== grantIdValue) grantFail("CLIENT_GRANT_IDENTITY_CONFLICT", 409,
        "Use the existing logical grant for this project and client");
      if (Date.parse(input.expires_at) <= instant) grantFail("CLIENT_GRANT_INPUT_INVALID", 400, "Grant expiry must be in the future");
      if (input.spend_policy_ref !== undefined) {
        if (!input.allowed_operations.some((op) => op === "run" || op === "recover")) {
          grantFail("CLIENT_GRANT_INPUT_INVALID", 400, "Spend sponsorship requires an explicit run or recover operation");
        }
        if (!options.authorize_spend) grantFail("CLIENT_GRANT_SPEND_NOT_SUPPORTED", 409,
          "Installed spend approval is not composed; read grants never authorize model charges");
        sponsorship = await options.authorize_spend(context, input);
        if (!/^[0-9a-f]{64}$/u.test(sponsorship.policy_sha256) ||
            !Number.isFinite(Date.parse(sponsorship.expires_at)) || Date.parse(sponsorship.expires_at) <= instant ||
            Date.parse(input.expires_at) > Date.parse(sponsorship.expires_at)) {
          grantFail("CLIENT_GRANT_SPEND_DENIED", 403, "Grant expiry exceeds its installed sponsorship approval");
        }
        grantId(sponsorship.deployment_generation);
        authorityDeadline = Math.min(authorityDeadline, Date.parse(sponsorship.expires_at));
      }
      const imports = input.allowed_operations.some((op) => op === "ingest.bundle" || op === "workspace.admit");
      if (imports && input.ingest_namespace_ids.length === 0) grantFail("CLIENT_GRANT_NAMESPACE_DENIED", 403, "Import rights require explicit namespaces");
      if (!imports && input.ingest_namespace_ids.length !== 0) grantFail("CLIENT_GRANT_INPUT_INVALID", 400, "Import namespaces require an import operation");
      await requireClientGrantNamespaces(db, principal, input.ingest_namespace_ids);
      const refs = await readClientProjectMembers(db, projectId, instant);
      const sourceAuthority = createOwnerScopeAuthority(db, context, now);
      const sources = await sourceAuthority.exhaustiveSources(refs);
      authorityDeadline = Math.min(authorityDeadline, Date.parse(input.expires_at),
        ...sources.flatMap((source) => [Date.parse(source.policy.expires_at),
          source.authority.admission_expires_at === undefined ? Infinity : Date.parse(source.authority.admission_expires_at)]));
      const boundary = await db.prepare("SELECT MIN(julianday(boundary)) AS boundary FROM (" +
        "SELECT valid_from AS boundary FROM project_source_membership WHERE project_id=?1 AND julianday(valid_from)>julianday(?2) " +
        "UNION ALL SELECT valid_to AS boundary FROM project_source_membership WHERE project_id=?1 AND julianday(valid_to)>julianday(?2))")
        .bind(projectId, timestamp).first<{ boundary: number | null }>();
      if (!boundary || (boundary.boundary !== null && !Number.isFinite(boundary.boundary))) {
        grantFail("CLIENT_GRANT_STORAGE_UNAVAILABLE", 503, "Project time boundary is unavailable", true);
      }
      if (boundary.boundary !== null) authorityDeadline = Math.min(authorityDeadline, Math.round((boundary.boundary - 2440587.5) * 86400000));
      const { expected_revision: _expected, ...rights } = input;
      result = ProjectClientGrantSchema.parse({ protocol: "eliotr.project-client-grant.v1", grant_id: grantIdValue,
        project_id: projectId, grantor_principal_ref: principal, revision: expected + 1, state: "ACTIVE", ...rights,
        created_at: previous?.created_at ?? timestamp, updated_at: timestamp });
    } else {
      if (!previous) grantFail("CLIENT_GRANT_REVISION_CONFLICT", 409, "Grant does not exist");
      sponsorship = await readClientGrantSpend(db, previous);
      result = { ...previous, state: "REVOKED", revision: expected + 1, updated_at: timestamp };
    }
    const record = canonicalJson(result); const digest = await sha256Utf8(record);
    if (new TextEncoder().encode(record).byteLength > CLIENT_GRANT_MAX_BYTES) grantFail("CLIENT_GRANT_INPUT_TOO_LARGE", 413, "Grant exceeds its byte envelope");
    owner(context);
    if (!Number.isFinite(authorityDeadline) || grantNow(now) >= authorityDeadline) {
      grantFail("CLIENT_GRANT_AUTHORITY_CHANGED", 409, "Authority expired before grant mutation", true);
    }
    try {
      await db.prepare("INSERT INTO project_client_grant (grant_id,revision,project_id,grantor_principal_ref," +
        "grantee_issuer,grantee_method,grantee_subject,state,expires_at,idempotency_key,request_sha256,record_json,record_sha256," +
        "spend_policy_sha256,spend_deployment_generation,spend_expires_at) " +
        "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?17,?18,?19 FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
        "WHERE p.project_id=?3 AND o.principal_ref=?4 AND p.generation=?14 " +
        "AND (SELECT generation FROM orientation_authority_epoch WHERE singleton=1)=?15 " +
        "AND julianday(?16)>julianday('now')")
        .bind(result.grant_id, result.revision, projectId, principal, result.grantee.issuer,
          result.grantee.authentication_method, result.grantee.subject, result.state, result.expires_at,
          key, requestDigest, record, digest, generation, epoch, new Date(authorityDeadline).toISOString(),
          sponsorship?.policy_sha256 ?? null, sponsorship?.deployment_generation ?? null, sponsorship?.expires_at ?? null).run();
    } catch { /* Lost ACK and CAS conflicts are reconciled by exact immutable receipt readback below. */ }
    const settled = await readGrantReplay(db, principal, key, requestDigest);
    if (settled !== null) {
      await requireGrantOwner(db, projectId, owner(context));
      if (canonicalJson(settled) !== record) grantFail("CLIENT_GRANT_STORAGE_CORRUPT", 503, "Grant receipt differs from its intended revision");
      if (canonicalJson(await readClientGrantSpend(db, settled)) !== canonicalJson(sponsorship)) {
        grantFail("CLIENT_GRANT_STORAGE_CORRUPT", 503, "Sponsorship receipt differs from its intended approval");
      }
      owner(context);
      return settled;
    }
    const current = await readClientGrant(db, grantIdValue);
    const actorGrant = await findClientGrant(db, projectId, result.grantee);
    if (actorGrant && actorGrant.grant_id !== grantIdValue) {
      grantFail("CLIENT_GRANT_IDENTITY_CONFLICT", 409, "Another logical grant already exists for this client");
    }
    if ((current?.revision ?? 0) !== expected || await grantEpoch(db) !== epoch) {
      grantFail("CLIENT_GRANT_REVISION_CONFLICT", 409, "Grant or upstream authority changed before commit");
    }
    grantFail("CLIENT_GRANT_SETTLEMENT_UNCERTAIN", 503, "No exact commit receipt; reconcile using the same idempotency key", true);
  }
  return { list,
    put: (context: AuthenticatedRequestContext, project: string, grant: string, input: unknown) => mutate(context, project, grant, input, "PUT"),
    revoke: (context: AuthenticatedRequestContext, project: string, grant: string, input: unknown) => mutate(context, project, grant, input, "DELETE") };
}
