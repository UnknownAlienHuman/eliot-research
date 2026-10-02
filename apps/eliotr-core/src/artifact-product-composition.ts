import { canonicalDigest } from "@eliotr/platform-cloudflare";
import type { ArtifactRevision, VersionedRef } from "@eliotr/contracts";
import {
  createArtifactPublicationProducer,
  type ArtifactOwnerAcceptanceDecision,
  type ArtifactPublicationAuthorityInput,
} from "@eliotr/cloudflare-research";
import type { EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import type {
  ArtifactPublicationAcceptRequest,
  ArtifactPublicationMutationResult,
  ArtifactPublicationReadResult,
  AuthenticatedRequestContext,
} from "@eliotr/interfaces";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import { ArtifactPublicationError } from "@eliotr/cloudflare-research";
import type { Env } from "./env.js";
import { prepareArtifactReadReauthorization } from "./research-artifact-reauthorization-http.js";
import { ArtifactReadNotFoundError } from "./artifact-draft-http.js";
import { HttpRequestError } from "./http-errors.js";

function access(context: AuthenticatedRequestContext): EvidenceAccessContext {
  return {
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
  };
}

function exactRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function assertOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa") {
    throw new HttpRequestError("ARTIFACT_PUBLICATION_DENIED", 403, "artifact acceptance requires an authenticated owner");
  }
}

function createDecisionFactory(
  request: ArtifactPublicationAcceptRequest,
  context: AuthenticatedRequestContext,
  current: Awaited<ReturnType<typeof prepareArtifactReadReauthorization>>,
): (input: {
  readonly artifact_ref: VersionedRef;
  readonly expected_draft_head_revision: number;
  readonly expected_publication_revision: number | null;
  readonly access: EvidenceAccessContext;
  readonly authorization: ArtifactPublicationAuthorityInput["current_authorization"];
  readonly draft: ArtifactRevision;
}) => Promise<ArtifactOwnerAcceptanceDecision> {
  return async (input) => {
    current.requireActiveRequest();
    await current.requireCurrent();
    if (!exactRef(input.artifact_ref, request.artifact_ref) ||
        input.expected_draft_head_revision !== request.expected_draft_head_revision ||
        input.expected_publication_revision !== request.expected_publication_revision ||
        input.access.principal_ref !== context.principal_ref ||
        input.access.credential_generation !== context.credential_generation ||
        input.access.client_class !== "owner_pwa" ||
        input.draft.status !== "DRAFT" || !exactRef(input.draft.artifact_ref, request.artifact_ref)) {
      throw new ArtifactPublicationError(
        "ARTIFACT_PUBLICATION_DENIED",
        "owner acceptance witness does not match the exact authenticated draft request",
      );
    }
    const authorization = input.authorization;
    if (!authorization.allowed_use.includes("research") || authorization.expires_at !== current.authorization.expires_at ||
        authorization.authorization_receipt_ref !== current.authorization.authorization_receipt_ref ||
        authorization.policy_authority_ref !== current.authorization.policy_authority_ref) {
      throw new ArtifactPublicationError(
        "ARTIFACT_PUBLICATION_DENIED",
        "current owner research authorization changed before acceptance",
      );
    }
    const scopeRef = {
      id: current.navigation.scope.snapshot_id,
      revision: current.navigation.scope.revision,
    };
    const expiresAt = authorization.expires_at;
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw new ArtifactPublicationError("ARTIFACT_PUBLICATION_STALE", "owner acceptance authorization has expired");
    }
    const digest = await canonicalDigest({
      protocol: "eliotr.artifact-owner-acceptance.v1",
      mode: "OWNER_EXPLICIT",
      artifact_ref: request.artifact_ref,
      expected_draft_head_revision: request.expected_draft_head_revision,
      expected_publication_revision: request.expected_publication_revision,
      principal_ref: context.principal_ref,
      credential_generation: context.credential_generation,
      idempotency_key: request.idempotency_key,
      scope_ref: scopeRef,
      authorization_receipt_ref: authorization.authorization_receipt_ref,
      policy_authority_ref: authorization.policy_authority_ref,
      expires_at: expiresAt,
    });
    return {
      protocol: "eliotr.artifact-owner-acceptance.v1",
      mode: "OWNER_EXPLICIT",
      artifact_ref: request.artifact_ref,
      expected_draft_head_revision: request.expected_draft_head_revision,
      expected_publication_revision: request.expected_publication_revision,
      principal_ref: context.principal_ref,
      credential_generation: context.credential_generation,
      idempotency_key: request.idempotency_key,
      decision_ref: `artifact-owner-accept-${digest}`,
      provenance_ref: `owner-explicit-accept-${digest}`,
      expires_at: expiresAt,
    };
  };
}

export async function acceptOwnerArtifact(
  env: Env,
  context: AuthenticatedRequestContext,
  request: ArtifactPublicationAcceptRequest,
): Promise<ArtifactPublicationMutationResult> {
  assertOwner(context);
  const current = await prepareArtifactReadReauthorization(env, context, request.artifact_ref, "report");
  current.requireActiveRequest();
  await current.requireCurrent();
  const now = Date.now;
  const scopes = createD1ScopeService(env.CORE_DB, createOwnerScopeAuthority(env.CORE_DB, context, now), { now });
  const producer = createArtifactPublicationProducer({
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    require_current: (scope) => scopes.requireCurrent(scope),
    now,
    resolve_acceptance_decision: createDecisionFactory(request, context, current),
  });
  const result = await producer.accept({
    artifact_ref: request.artifact_ref,
    access: access(context),
    current_navigation: current.navigation,
    current_authorization: current.authorization,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    deployment_generation: env.DEPLOYMENT_GENERATION,
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
  assertOwner(context);
  const current = await prepareArtifactReadReauthorization(env, context, artifactRef, "report");
  current.requireActiveRequest();
  await current.requireCurrent();
  const now = Date.now;
  const scopes = createD1ScopeService(env.CORE_DB, createOwnerScopeAuthority(env.CORE_DB, context, now), { now });
  const producer = createArtifactPublicationProducer({
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    require_current: (scope) => scopes.requireCurrent(scope),
    now,
  });
  const publication = await producer.read({
    artifact_ref: artifactRef,
    access: access(context),
    current_navigation: current.navigation,
    current_authorization: current.authorization,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  });
  if (publication === null) throw new ArtifactReadNotFoundError("artifact has no accepted publication");
  return { protocol: "eliotr.artifact-publication.v1", ...publication };
}
