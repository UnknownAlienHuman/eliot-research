import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ResearchProviderKeyConfigurationService } from "@eliotr/cloudflare-model-control";
import {
  createResearchProviderKeyModelUseService as createPackageResearchProviderKeyModelUseService,
  ResearchProviderKeyModelUseServiceError,
  type ResearchProviderKeyModelUseService,
} from "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-service.js";
import type { Env } from "./env.js";
import type { ResearchProjectModelConfigurationService } from "./research-project-configuration.js";
import { createResearchProviderNativeModelAuthority } from "./research-provider-native-model-authority.js";
import { createResearchProviderKeyModelUsePlanInputsFromEnv } from "./research-provider-key-model-use-plan.js";

export { ResearchProviderKeyModelUseServiceError };
export type { ResearchProviderKeyModelUseService };

export function createResearchProviderKeyModelUseService(input: {
  readonly env: Env;
  readonly context: AuthenticatedRequestContext;
  readonly project_id: string;
  readonly key_configuration: ResearchProviderKeyConfigurationService;
  readonly project_configuration: ResearchProjectModelConfigurationService;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
}): ResearchProviderKeyModelUseService {
  if (input.env.CORE_DB === undefined) {
    throw new ResearchProviderKeyModelUseServiceError(
      "PROVIDER_KEY_MODEL_USE_UNAVAILABLE", 503, "Model-key check/use is temporarily unavailable", true,
    );
  }
  const planInputs = createResearchProviderKeyModelUsePlanInputsFromEnv(input.env);
  const runtime_policy = Object.freeze({
    ...planInputs.runtime_policy,
    deployment_generation: input.env.DEPLOYMENT_GENERATION,
    gateway_base_url: input.env.AI_GATEWAY_REASONING_URL,
    ...(input.env.ELIOTR_MODEL_GATEWAY_TOKEN === undefined
      ? {}
      : { gateway_token: input.env.ELIOTR_MODEL_GATEWAY_TOKEN }),
  });
  return createPackageResearchProviderKeyModelUseService({
    database: input.env.CORE_DB,
    runtime_policy,
    semantic_source: planInputs.semantic_source,
    context: input.context,
    project_id: input.project_id,
    key_configuration: input.key_configuration,
    project_configuration: input.project_configuration,
    native_authority_factory: (authorityInput) => createResearchProviderNativeModelAuthority({
      env: input.env,
      current_scope: authorityInput.current_scope,
      readConfiguredOperation: authorityInput.readConfiguredOperation,
    }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
}
