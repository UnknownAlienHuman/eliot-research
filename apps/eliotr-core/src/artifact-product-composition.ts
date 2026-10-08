import type { VersionedRef } from "@eliotr/contracts";
import type { EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import type {
  ArtifactPublicationAcceptRequest,
  ArtifactPublicationMutationResult,
  ArtifactPublicationReadResult,
  AuthenticatedRequestContext,
} from "@eliotr/interfaces";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { createArtifactProductService } from "@eliotr/cloudflare-artifacts/artifact-product-service.js";
import type { Env } from "./env.js";
import { prepareArtifactReadReauthorization } from "./research-artifact-reauthorization-http.js";
import { HttpRequestError } from "./http-errors.js";

function access(context: AuthenticatedRequestContext): EvidenceAccessContext {
  return {
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
  };
}

function createOwnerArtifactProductService(env: Env, context: AuthenticatedRequestContext) {
  const now = Date.now;
  return createArtifactProductService({
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    access: access(context),
    now,
    require_owner: () => {
      if (context.client_class !== "owner_pwa") {
        throw new HttpRequestError("ARTIFACT_PUBLICATION_DENIED", 403, "artifact acceptance requires an authenticated owner");
      }
    },
    create_require_current: () => {
      const scopes = createD1ScopeService(env.CORE_DB, createOwnerScopeAuthority(env.CORE_DB, context, now), { now });
      return (scope) => scopes.requireCurrent(scope);
    },
    prepare_read_authority: (artifactRef, operation) => prepareArtifactReadReauthorization(env, context, artifactRef, operation),
    stale_current_draft: () => {
      throw new HttpRequestError("ARTIFACT_PUBLICATION_STALE", 409, "Draft or publication head changed; reopen the current draft");
    },
  });
}

export async function acceptOwnerArtifact(
  env: Env,
  context: AuthenticatedRequestContext,
  request: ArtifactPublicationAcceptRequest,
): Promise<ArtifactPublicationMutationResult> {
  const result = await createOwnerArtifactProductService(env, context).accept({
    artifact_ref: request.artifact_ref,
    expected_draft_head_revision: request.expected_draft_head_revision,
    expected_publication_revision: request.expected_publication_revision,
    idempotency_key: request.idempotency_key,
  });
  return { protocol: "eliotr.artifact-publication.v1", ...result };
}

export async function readOwnerArtifactPublication(
  env: Env,
  context: AuthenticatedRequestContext,
  artifactRef: VersionedRef,
): Promise<ArtifactPublicationReadResult> {
  const publication = await createOwnerArtifactProductService(env, context).read(artifactRef);
  return { protocol: "eliotr.artifact-publication.v1", ...publication };
}

/** Read the exact publication CAS target for the current draft through the existing validator. */
export async function readOwnerArtifactCurrentPublication(
  env: Env,
  context: AuthenticatedRequestContext,
  artifactRef: VersionedRef,
): Promise<ArtifactPublicationReadResult> {
  const publication = await createOwnerArtifactProductService(env, context).readCurrent(artifactRef);
  return { protocol: "eliotr.artifact-publication.v1", ...publication };
}
