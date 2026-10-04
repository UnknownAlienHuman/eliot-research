import type { VerifyEvidenceRequest, VerifyEvidenceResult, VersionedRef } from "@eliotr/contracts";
import { createD1EvidenceAuthorityPort } from "./authority.js";
import {
  createEvidenceServiceCapability,
  type EvidenceRange,
  type RequireEvidenceCurrent,
} from "./evidence-service-capability.js";
import { createR2EvidenceContentPort } from "./content-store.js";
import { createCloudflareEvidenceResolver } from "./resolver.js";
import type { CloudflareEvidenceResolver, EvidenceAccessContext } from "./types.js";

export interface EvidenceDelegatedGrant {
  readonly grant_id: string;
  readonly revision: number;
  readonly project_id: string;
  readonly project_generation: number;
  readonly operation: string;
}

export type EvidenceDelegatedGrantAuthorizer =
  (grant: EvidenceDelegatedGrant) => Promise<RequireEvidenceCurrent>;

export class EvidenceDelegatedGrantError extends Error {
  public constructor(
    public readonly code: "SCOPE_NOT_READY" | "OPERATION_DENIED",
    cause?: unknown,
  ) {
    super(code === "SCOPE_NOT_READY"
      ? "delegated evidence scope is unavailable"
      : "delegated scope does not allow standalone evidence reads",
      cause === undefined ? undefined : { cause });
    this.name = "EvidenceDelegatedGrantError";
  }
}

export interface CloudflareEvidenceServiceDependencies {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly resolver?: CloudflareEvidenceResolver;
}

type EvidenceGrantTarget =
  | { readonly scope_ref: VersionedRef }
  | { readonly handle_ref: VersionedRef };

const NO_CURRENTNESS_CHECK: RequireEvidenceCurrent = async () => {};

async function persistedGrantCurrentness(
  database: D1Database,
  access: EvidenceAccessContext,
  target: EvidenceGrantTarget,
  authorize: EvidenceDelegatedGrantAuthorizer,
): Promise<RequireEvidenceCurrent> {
  if (access.client_class === "owner_pwa") return NO_CURRENTNESS_CHECK;

  const ref = "scope_ref" in target ? target.scope_ref : target.handle_ref;
  const handleJoin = "handle_ref" in target
    ? "JOIN evidence_handle h ON h.scope_snapshot_id=g.snapshot_id AND h.scope_snapshot_revision=g.snapshot_revision "
    : "";
  const targetWhere = "handle_ref" in target
    ? "h.handle_id=?1 AND h.revision=?2"
    : "g.snapshot_id=?1 AND g.snapshot_revision=?2";
  let grant: EvidenceDelegatedGrant | null;
  try {
    grant = await database.prepare(
      "SELECT g.project_client_grant_id AS grant_id,g.project_client_grant_revision AS revision," +
      "d.project_id,g.project_client_project_generation AS project_generation,g.project_client_operation AS operation " +
      "FROM scope_access_grant g " + handleJoin +
      "JOIN project_client_grant d ON d.grant_id=g.project_client_grant_id " +
      "AND d.revision=g.project_client_grant_revision " +
      `WHERE ${targetWhere} AND g.principal_ref=?3 AND g.client_class=?4 AND g.credential_generation=?5`,
    ).bind(ref.id, ref.revision, access.principal_ref, access.client_class, access.credential_generation)
      .first<EvidenceDelegatedGrant>();
  } catch (cause) {
    throw new EvidenceDelegatedGrantError("SCOPE_NOT_READY", cause);
  }

  // Missing delegated rows retain the resolver's legacy handling for non-delegated scopes.
  if (grant === null) return NO_CURRENTNESS_CHECK;
  if (grant.operation !== "query" && grant.operation !== "evidence" && grant.operation !== "run") {
    throw new EvidenceDelegatedGrantError("OPERATION_DENIED");
  }
  const requireCurrent = await authorize(grant);
  await requireCurrent();
  return requireCurrent;
}

/** Builds the D1/R2 resolver and applies persisted delegated-scope currentness to public reads. */
export function createCloudflareEvidenceService(dependencies: CloudflareEvidenceServiceDependencies) {
  const resolver = dependencies.resolver ?? createCloudflareEvidenceResolver({
    authority: createD1EvidenceAuthorityPort({
      core_database: dependencies.core_database,
      search_database: dependencies.search_database,
    }),
    content: createR2EvidenceContentPort({ evidence_bucket: dependencies.evidence_bucket }),
  });
  const capability = createEvidenceServiceCapability(resolver);
  return {
    async verify(
      access: EvidenceAccessContext,
      request: VerifyEvidenceRequest,
      authorizeDelegatedGrant: EvidenceDelegatedGrantAuthorizer,
    ): Promise<VerifyEvidenceResult> {
      const requireCurrent = await persistedGrantCurrentness(
        dependencies.core_database,
        access,
        { scope_ref: request.scope_snapshot_ref },
        authorizeDelegatedGrant,
      );
      return capability.verify(access, request, requireCurrent);
    },
    async open(
      access: EvidenceAccessContext,
      handleRef: VersionedRef,
      range: EvidenceRange | undefined,
      authorizeDelegatedGrant: EvidenceDelegatedGrantAuthorizer,
    ): Promise<Response> {
      const requireCurrent = await persistedGrantCurrentness(
        dependencies.core_database,
        access,
        { handle_ref: handleRef },
        authorizeDelegatedGrant,
      );
      return capability.open(access, handleRef, range, requireCurrent);
    },
  };
}
