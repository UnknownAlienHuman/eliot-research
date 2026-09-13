import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import {
  createNavigationReadAuthority,
  loadScopeAuthority,
  type NavigationReadAuthority,
  type ScopeAuthorization,
} from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority } from "@eliotr/cloudflare-navigation";
import {
  ArtifactDraftReadError,
  readReauthorizedArtifactDraft,
  readReauthorizedArtifactDraftSectionCitations,
} from "@eliotr/cloudflare-research";
import { ArtifactReadNotFoundError, artifactSectionResponse, type AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";

interface OwnerArtifactReauthorization {
  readonly artifact_ref: VersionedRef;
  readonly navigation: NavigationReadAuthority;
  readonly authorization: ScopeAuthorization;
  readonly requireActiveRequest: () => void;
}

/** Original artifact authority is provenance; every reopen obtains a new owner read grant. */
async function prepareOwnerArtifactReauthorization(
  env: Env,
  context: AuthenticatedRequestContext,
  artifactRef: VersionedRef,
): Promise<OwnerArtifactReauthorization> {
  if (context.client_class !== "owner_pwa") {
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_DENIED", 403, "Owner access is required");
  }
  const requireActiveRequest = () => {
    if (context.request.signal.aborted) throw new HttpRequestError("RESEARCH_CANCELLED", 409, "Report reading was cancelled");
  };
  requireActiveRequest();
  const ref = VersionedRefSchema.parse(artifactRef);
  const binding = await env.CORE_DB.prepare(
    "SELECT b.scope_snapshot_id,b.scope_snapshot_revision FROM artifact_draft_binding b " +
    "JOIN artifact_revision a ON a.artifact_id=b.artifact_id AND a.revision=b.revision " +
    "WHERE b.artifact_id=?1 AND b.revision=?2 AND b.principal_ref=?3 AND a.status='DRAFT' LIMIT 1",
  ).bind(ref.id, ref.revision, context.principal_ref)
    .first<{ scope_snapshot_id: string; scope_snapshot_revision: number }>();
  if (binding === null) throw new ArtifactReadNotFoundError();
  const original = await loadScopeAuthority(env.CORE_DB, VersionedRefSchema.parse({
    id: binding.scope_snapshot_id, revision: binding.scope_snapshot_revision,
  }));
  if (original === null || original.invalidated_at !== null) {
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_STALE", 410, "The saved report's sources are no longer available");
  }
  const now = Date.now;
  const authority = createOwnerScopeAuthority(env.CORE_DB, context, now);
  await authority.requireReadPolicy();
  requireActiveRequest();
  const scopes = createD1ScopeService(env.CORE_DB, authority, { now, max_snapshot_members: 64 });
  const fresh = await scopes.freeze(original.snapshot.resolved_scope_expression, context.credential_generation);
  await scopes.requireCurrent(fresh);
  requireActiveRequest();
  await authority.grant(fresh);
  const navigation = createNavigationReadAuthority({
    database: env.CORE_DB, scope_snapshot: fresh, access: context,
    require_current: (scope) => scopes.requireCurrent(scope), now,
  });
  const authorization = await navigation.current();
  return { artifact_ref: ref, navigation, authorization, requireActiveRequest };
}

export async function reopenOwnerArtifactDraft(
  env: Env,
  context: AuthenticatedRequestContext,
  artifactRef: VersionedRef,
  sectionRef?: VersionedRef,
) {
  const prepared = await prepareOwnerArtifactReauthorization(env, context, artifactRef);
  const result = await readReauthorizedArtifactDraft({
    database: env.CORE_DB, work_bucket: env.WORK_BUCKET, artifact_ref: prepared.artifact_ref, access: context,
    current_navigation: prepared.navigation, current_authorization: prepared.authorization,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    ...(sectionRef === undefined ? {} : { section_ref: VersionedRefSchema.parse(sectionRef) }),
  });
  prepared.requireActiveRequest();
  if (result === null) throw new ArtifactReadNotFoundError();
  return result;
}

export async function reopenOwnerArtifactSection(
  env: Env,
  context: AuthenticatedRequestContext,
  artifactRef: VersionedRef,
  sectionRef: VersionedRef,
): Promise<Response> {
  const reopened = await reopenOwnerArtifactDraft(env, context, artifactRef, sectionRef);
  if (!("body" in reopened.artifact)) {
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "The report section is inconsistent");
  }
  const response = artifactSectionResponse(reopened.artifact);
  response.headers.set("x-eliotr-deployment-generation", env.DEPLOYMENT_GENERATION);
  return response;
}

export async function reopenOwnerArtifactSectionCitations(
  env: Env,
  context: AuthenticatedRequestContext,
  artifactRef: VersionedRef,
  sectionRef: VersionedRef,
) {
  const prepared = await prepareOwnerArtifactReauthorization(env, context, artifactRef);
  const result = await readReauthorizedArtifactDraftSectionCitations({
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    artifact_ref: prepared.artifact_ref,
    section_ref: VersionedRefSchema.parse(sectionRef),
    access: context,
    current_navigation: prepared.navigation,
    current_authorization: prepared.authorization,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  });
  prepared.requireActiveRequest();
  if (result === null) throw new ArtifactReadNotFoundError("artifact section citations do not exist");
  return result;
}
