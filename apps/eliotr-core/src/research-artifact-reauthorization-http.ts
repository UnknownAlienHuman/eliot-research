import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  createNavigationReadAuthority,
  loadScopeAuthority,
  type NavigationReadAuthority,
  type ScopeAuthorization,
} from "@eliotr/cloudflare-evidence";
import {
  reauthorizeOwnerHistoricalScope,
} from "@eliotr/cloudflare-navigation";
import {
  ArtifactDraftReadError,
  readReauthorizedArtifactDraft,
  readReauthorizedArtifactDraftSectionCitations,
} from "@eliotr/cloudflare-research";
import { ArtifactReadNotFoundError, artifactSectionResponse, type AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";
import { readSourceRevisionFreshness } from "./source-revision-freshness.js";

interface OwnerArtifactReauthorization {
  readonly artifact_ref: VersionedRef;
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly navigation: NavigationReadAuthority;
  readonly authorization: ScopeAuthorization;
  readonly requireActiveRequest: () => void;
  readonly requireCurrent: () => Promise<void>;
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
  const originalScopeRef = VersionedRefSchema.parse({
    id: binding.scope_snapshot_id, revision: binding.scope_snapshot_revision,
  });
  const original = await loadScopeAuthority(env.CORE_DB, originalScopeRef);
  if (original === null ||
      (original.invalidated_at !== null && original.invalidation_reason !== "SCOPE_INPUT_CHANGED")) {
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_STALE", 410, "The saved report's sources are no longer available");
  }
  const now = Date.now;
  requireActiveRequest();
  const historical = await reauthorizeOwnerHistoricalScope({
    database: env.CORE_DB,
    access: context,
    original_ref: {
      id: binding.scope_snapshot_id,
      revision: binding.scope_snapshot_revision,
    },
    original: original.snapshot,
    now,
  });
  requireActiveRequest();
  const navigation = createNavigationReadAuthority({
    database: env.CORE_DB,
    scope_snapshot: historical.scope,
    access: context,
    require_current: historical.requireCurrent,
    now,
  });
  const authorization = await navigation.current();
  const requireCurrent = async (): Promise<void> => {
    requireActiveRequest();
    const currentAuthorization = await navigation.current();
    if (canonicalEvidenceJson(currentAuthorization) !== canonicalEvidenceJson(authorization)) {
      throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_STALE", 410, "The saved report authorization changed during read");
    }
    await navigation.sources(historical.scope.member_source_revision_refs, currentAuthorization);
    requireActiveRequest();
  };
  return {
    artifact_ref: ref,
    original_scope_snapshot_ref: originalScopeRef,
    navigation,
    authorization,
    requireActiveRequest,
    requireCurrent,
  };
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
  if (sectionRef !== undefined) return result;
  const sourceFreshness = await readSourceRevisionFreshness(env.CORE_DB, {
    original_scope_snapshot_ref: prepared.original_scope_snapshot_ref,
    navigation: prepared.navigation,
    requireCurrent: prepared.requireCurrent,
  });
  return {
    ...result,
    protocol: "eliotr.artifact-draft-reauthorization.v2" as const,
    source_freshness: sourceFreshness,
  };
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
