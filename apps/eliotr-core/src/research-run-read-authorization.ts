import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { requireWorkflowRunStatusContinuity as requireRunStatusContinuity } from "@eliotr/cloudflare-workflows";
import type { Env } from "./env.js";
import { reopenOwnerArtifactDraft } from "./research-artifact-reauthorization-http.js";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";
import {
  createRunArtifactReadback as createRunArtifactReadbackCapability,
  prepareReauthenticatedRunRead as prepareReauthenticatedRunReadCapability,
  readReauthenticatedRunAnswer as readReauthenticatedRunAnswerCapability,
} from "@eliotr/cloudflare-research-runtime";
import type {
  ReauthenticatedRunRead,
  ResearchRunRead,
  ResearchRunControlFence,
  ResearchRunReadEnvironment,
  ReopenedResearchRunDraft,
} from "@eliotr/cloudflare-research-runtime";

export function createResearchRunReadEnvironment(env: Env): ResearchRunReadEnvironment {
  return {
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    active_deployment_generation: env.DEPLOYMENT_GENERATION,
    require_deployment_compatibility: (origin, active) =>
      requireResearchDeploymentCompatibility(env.CORE_DB, origin, active),
    reopen_owner_artifact_draft: (context, artifactRef) => reopenOwnerArtifactDraft(env, context, artifactRef),
  };
}

export { requireRunStatusContinuity };

export function prepareReauthenticatedRunRead(
  env: Env,
  context: AuthenticatedRequestContext,
  operationId: string,
  forControl = false,
): Promise<ReauthenticatedRunRead | null> {
  return prepareReauthenticatedRunReadCapability(createResearchRunReadEnvironment(env), context, operationId, forControl);
}

export function createRunArtifactReadback(
  env: Env,
  context: AuthenticatedRequestContext,
  read: ResearchRunRead,
 ) {
  return createRunArtifactReadbackCapability(createResearchRunReadEnvironment(env), context, read);
}

export function readReauthenticatedRunAnswer(
  env: Env,
  context: AuthenticatedRequestContext,
  read: ReauthenticatedRunRead,
  materializeHandlerGeneration: string,
) {
  return readReauthenticatedRunAnswerCapability(
    createResearchRunReadEnvironment(env), context, read, materializeHandlerGeneration,
  );
}

export type { ReauthenticatedRunRead, ResearchRunRead, ResearchRunControlFence, ReopenedResearchRunDraft };
