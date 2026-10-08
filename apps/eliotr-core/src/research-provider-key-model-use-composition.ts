import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { createOwnerResearchProjectConfigurationService } from "./research-project-configuration-composition.js";
import { createResearchProviderKeyConfigurationComposition } from "./research-provider-key-configuration-composition.js";
import { createResearchProviderKeyModelUseService } from "./research-provider-key-model-use-service.js";

/** One authenticated owner/project context for key readback, Native probing, and config CAS. */
export function createResearchProviderKeyModelUseComposition(
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
) {
  const keyConfiguration = createResearchProviderKeyConfigurationComposition(env).service;
  const projectConfiguration = createOwnerResearchProjectConfigurationService(env, context, projectId);
  return createResearchProviderKeyModelUseService({
    env,
    context,
    project_id: projectId,
    key_configuration: keyConfiguration,
    project_configuration: projectConfiguration,
  });
}
