import type {
  AuthenticatedRequestContext,
  VerifyEvidenceRequest,
  VerifyEvidenceResult,
} from "@eliotr/interfaces";
import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  createEvidenceServiceCapability,
  type CloudflareEvidenceResolver,
  type EvidenceAccessContext,
} from "@eliotr/cloudflare-evidence";
import type { VersionedRef } from "@eliotr/contracts";
import type { Env } from "./env.js";
import { authorizeProjectClientGrant, ClientGrantError } from "@eliotr/cloudflare-navigation";

export interface EvidenceService {
  verify(context: AuthenticatedRequestContext, request: VerifyEvidenceRequest): Promise<VerifyEvidenceResult>;
  open(
    context: AuthenticatedRequestContext,
    handleRef: VersionedRef,
    range?: { readonly start: number; readonly end: number },
  ): Promise<Response>;
}

export interface EvidenceServiceDependencies {
  readonly resolver?: CloudflareEvidenceResolver;
}

function access(context: AuthenticatedRequestContext): EvidenceAccessContext {
  return {
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
  };
}

/** Public evidence reads require their own operation; query's internal resolver has no such HTTP capability. */
async function requireDelegatedEvidence(db: D1Database, context: AuthenticatedRequestContext,
  target: { readonly scope_ref: VersionedRef } | { readonly handle_ref: VersionedRef }): Promise<() => Promise<void>> {
  if (context.client_class === "owner_pwa") return async () => {};
  const ref = "scope_ref" in target ? target.scope_ref : target.handle_ref;
  const handleJoin = "handle_ref" in target
    ? "JOIN evidence_handle h ON h.scope_snapshot_id=g.snapshot_id AND h.scope_snapshot_revision=g.snapshot_revision "
    : "";
  const targetWhere = "handle_ref" in target ? "h.handle_id=?1 AND h.revision=?2" : "g.snapshot_id=?1 AND g.snapshot_revision=?2";
  let row: { grant_id: string; revision: number; project_id: string; project_generation: number; operation: string } | null;
  try {
    row = await db.prepare("SELECT g.project_client_grant_id AS grant_id,g.project_client_grant_revision AS revision," +
      "d.project_id,g.project_client_project_generation AS project_generation,g.project_client_operation AS operation FROM scope_access_grant g " + handleJoin +
      "JOIN project_client_grant d ON d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision " +
      `WHERE ${targetWhere} AND g.principal_ref=?3 AND g.client_class=?4 AND g.credential_generation=?5`)
      .bind(ref.id, ref.revision, context.principal_ref, context.client_class, context.credential_generation)
      .first<{ grant_id: string; revision: number; project_id: string; project_generation: number; operation: string }>();
  } catch {
    throw new ClientGrantError("CLIENT_SCOPE_NOT_READY", 503, "Evidence scope authorization is unavailable; migration 0073 is required", true);
  }
  // Non-delegated legacy grants retain their original resolver path. Missing grants are denied there.
  if (row === null) return async () => {};
  if (row.operation !== "query" && row.operation !== "evidence" && row.operation !== "run") {
    throw new ClientGrantError("CLIENT_EVIDENCE_DENIED", 403, "Report body authority does not allow standalone evidence reads");
  }
  const lease = await authorizeProjectClientGrant(db, context, {
    operation: "evidence", project_id: row.project_id, required_revision: row.revision,
  });
  if (lease.grant.grant_id !== row.grant_id || lease.project_generation !== row.project_generation) {
    throw new ClientGrantError("CLIENT_SCOPE_AUTHORITY_STALE", 403, "Evidence scope belongs to a different delegation");
  }
  await lease.requireCurrent();
  return lease.requireCurrent;
}

// IMPLEMENTED_NOT_LIVE: ER-07/ER-11 exact evidence requires live D1/R2 range readback receipts.
export function createEvidenceService(
  env: Env,
  dependencies: EvidenceServiceDependencies = {},
): EvidenceService {
  const resolver = dependencies.resolver ?? createCloudflareEvidenceResolver({
    authority: createD1EvidenceAuthorityPort({
      core_database: env.CORE_DB,
      search_database: env.SEARCH_DB,
    }),
    content: createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET }),
  });
  const capability = createEvidenceServiceCapability(resolver);
  return {
    async verify(context, request) {
      const requireCurrent = await requireDelegatedEvidence(env.CORE_DB, context, { scope_ref: request.scope_snapshot_ref });
      return capability.verify(access(context), request, requireCurrent);
    },
    async open(context, handleRef, range) {
      const requireCurrent = await requireDelegatedEvidence(env.CORE_DB, context, { handle_ref: handleRef });
      return capability.open(access(context), handleRef, range, requireCurrent);
    },
  };
}
