import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { VersionedRef } from "@eliotr/contracts";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import type { Env } from "./env.js";
import { createResearchRunService } from "./research-session.js";
import { prepareArtifactReadReauthorization, reopenOwnerArtifactDraft } from "./research-artifact-reauthorization-http.js";
import { researchSemanticConfigurationInstalled } from "./research-semantic-server.js";
import { createResearchRunReadEnvironment } from "./research-run-read-authorization.js";
import { readOwnerResearchRuns as readOwnerResearchRunsCapability } from "@eliotr/cloudflare-research-runtime";

export async function readOwnerResearchRuns(env: Env, context: AuthenticatedRequestContext) {
  const runService = createResearchRunService(env);
  return readOwnerResearchRunsCapability({
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    run_read: createResearchRunReadEnvironment(env),
    authorize_owner_read: (actor) => {
      if (actor.client_class !== "owner_pwa") {
        throw new CatalogInputError("RESEARCH_OWNER_REQUIRED", "Research history requires an owner session", 403);
      }
    },
    run_status: (requestContext, operationId) => runService.runStatus(requestContext, operationId),
    prepare_artifact_read: (requestContext, artifactRef, operation) =>
      prepareArtifactReadReauthorization(env, requestContext, artifactRef, operation),
    reopen_owner_artifact_draft: (requestContext, artifactRef) =>
      reopenOwnerArtifactDraft(env, requestContext, artifactRef),
    semantic_configuration_installed: () => researchSemanticConfigurationInstalled(env),
  }, context);
}

export type { VersionedRef };
