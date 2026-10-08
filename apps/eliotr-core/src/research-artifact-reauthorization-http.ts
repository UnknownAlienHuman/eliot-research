import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { reauthorizeClientArtifactScope } from "@eliotr/cloudflare-navigation";
import { ArtifactDraftReadError } from "@eliotr/cloudflare-artifacts/artifact-draft-reader.js";
import {
  createArtifactDraftReadService,
  type ArtifactDraftReadReauthorization,
} from "@eliotr/cloudflare-artifacts/artifact-draft-read-service.js";
import { ArtifactReadNotFoundError, artifactSectionResponse, type AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";

function accessContext(context: AuthenticatedRequestContext) {
  return {
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
  };
}

function requireActiveRequest(context: AuthenticatedRequestContext): void {
  if (context.request.signal.aborted) {
    throw new HttpRequestError("RESEARCH_CANCELLED", 409, "Report reading was cancelled");
  }
  const access = context.access;
  if (access !== undefined && (access.principal_ref !== context.principal_ref ||
      access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(access.expires_at)) || Date.parse(access.expires_at) <= Date.now())) {
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_DENIED", 403, "Report credentials are no longer valid");
  }
}

function createReadService(env: Env, context: AuthenticatedRequestContext) {
  return createArtifactDraftReadService({
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    reauthorize_client_scope: (input) => reauthorizeClientArtifactScope({
      database: input.database,
      access: context,
      original_ref: input.original_ref,
      original: input.original,
      now: input.now,
      original_principal_ref: input.original_principal_ref,
      origin: { artifact_ref: input.artifact_ref, operation: input.operation },
    }),
  });
}

/** Fresh read authority retains the exact saved author, artifact and source revisions; it never renews execution. */
export async function prepareArtifactReadReauthorization(
  env: Env,
  context: AuthenticatedRequestContext,
  artifactRef: VersionedRef,
  operation: "report" | "evidence",
): Promise<ArtifactDraftReadReauthorization> {
  const prepared = await createReadService(env, context).prepare({
    access: accessContext(context),
    artifact_ref: artifactRef,
    operation,
    require_active_request: () => requireActiveRequest(context),
  });
  if (prepared === null) throw new ArtifactReadNotFoundError();
  return prepared;
}

export async function reopenOwnerArtifactDraft(
  env: Env,
  context: AuthenticatedRequestContext,
  artifactRef: VersionedRef,
  sectionRef?: VersionedRef,
) {
  const result = await createReadService(env, context).reopen({
    access: accessContext(context),
    artifact_ref: artifactRef,
    operation: "report",
    require_active_request: () => requireActiveRequest(context),
    ...(sectionRef === undefined ? {} : { section_ref: VersionedRefSchema.parse(sectionRef) }),
  });
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
  const result = await createReadService(env, context).sectionCitations({
    access: accessContext(context),
    artifact_ref: artifactRef,
    operation: "evidence",
    section_ref: VersionedRefSchema.parse(sectionRef),
    require_active_request: () => requireActiveRequest(context),
  });
  if (result === null) throw new ArtifactReadNotFoundError("artifact section citations do not exist");
  return result;
}
