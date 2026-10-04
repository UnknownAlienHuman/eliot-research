import type {
  AuthenticatedRequestContext,
  VerifyEvidenceRequest,
  VerifyEvidenceResult,
} from "@eliotr/interfaces";
import {
  createCloudflareEvidenceService,
  EvidenceDelegatedGrantError,
  type CloudflareEvidenceResolver,
  type EvidenceDelegatedGrant,
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

function access(context: AuthenticatedRequestContext) {
  return {
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
  };
}

function authorizePersistedGrant(
  database: D1Database,
  context: AuthenticatedRequestContext,
): (grant: EvidenceDelegatedGrant) => Promise<() => Promise<void>> {
  return async (grant) => {
    const lease = await authorizeProjectClientGrant(database, context, {
      operation: "evidence", project_id: grant.project_id, required_revision: grant.revision,
    });
    if (lease.grant.grant_id !== grant.grant_id || lease.project_generation !== grant.project_generation) {
      throw new ClientGrantError("CLIENT_SCOPE_AUTHORITY_STALE", 403, "Evidence scope belongs to a different delegation");
    }
    return lease.requireCurrent;
  };
}

function preserveGrantErrors(error: unknown): never {
  if (!(error instanceof EvidenceDelegatedGrantError)) throw error;
  if (error.code === "SCOPE_NOT_READY") {
    throw new ClientGrantError("CLIENT_SCOPE_NOT_READY", 503,
      "Evidence scope authorization is unavailable; migration 0073 is required", true);
  }
  throw new ClientGrantError("CLIENT_EVIDENCE_DENIED", 403,
    "Report body authority does not allow standalone evidence reads");
}

// IMPLEMENTED_NOT_LIVE: ER-07/ER-11 exact evidence requires live D1/R2 range readback receipts.
export function createEvidenceService(
  env: Env,
  dependencies: EvidenceServiceDependencies = {},
): EvidenceService {
  const service = createCloudflareEvidenceService({
    core_database: env.CORE_DB,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    ...(dependencies.resolver === undefined ? {} : { resolver: dependencies.resolver }),
  });
  return {
    async verify(context, request) {
      try {
        return await service.verify(access(context), request, authorizePersistedGrant(env.CORE_DB, context));
      } catch (error) {
        preserveGrantErrors(error);
      }
    },
    async open(context, handleRef, range) {
      try {
        return await service.open(access(context), handleRef, range, authorizePersistedGrant(env.CORE_DB, context));
      } catch (error) {
        preserveGrantErrors(error);
      }
    },
  };
}
