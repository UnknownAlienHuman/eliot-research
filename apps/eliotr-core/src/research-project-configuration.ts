import {
  createResearchProjectModelConfigurationService as createConfigurationService,
  readSelectedResearchProjectConfiguration,
  RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
  ResearchProjectModelConfigurationAuthorityError,
  type AssertCurrentResearchProjectAuthority,
  type ResearchProjectModelConfigurationService,
  type ResearchProjectNativeModelAuthorityFactory,
} from "@eliotr/cloudflare-research-configuration/research-project-configuration.js";
import { fail } from "@eliotr/cloudflare-research-configuration/research-project-configuration-validation.js";
import type { Env } from "./env.js";
import { createOwnerResearchProviderNativeModelAuthority } from "./research-provider-native-model-authority.js";
import type { ResearchProviderKeyModelUseDbPhase } from "./research-provider-key-model-use-store.js";

export {
  readSelectedResearchProjectConfiguration,
  RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
  ResearchProjectModelConfigurationAuthorityError,
};
export type {
  AssertCurrentResearchProjectAuthority,
  ResearchProjectModelConfigurationService,
  ResearchProjectNativeModelAuthorityFactory,
  SelectedResearchProjectConfiguration,
  ResearchProjectModelConfigurationSummary,
  ResearchProjectModelConfigurationPage,
  ResearchProjectModelConfigurationSelectionReceipt,
} from "@eliotr/cloudflare-research-configuration/research-project-configuration.js";
export type { ResearchProjectModelConfigurationBundle, ResearchProjectModelConfigurationSelection,
  ResearchProjectModelSelection } from "@eliotr/cloudflare-research";
/** Core compatibility entry point; Env is reduced to explicit package options. */
export function createResearchProjectModelConfigurationService(options: {
  readonly database: D1Database;
  readonly env?: Env;
  readonly assertCurrentProjectAuthority?: AssertCurrentResearchProjectAuthority;
  readonly native_model_authority?: ResearchProjectNativeModelAuthorityFactory;
  readonly deployment_environment?: "TEST" | "PRODUCTION";
  readonly deployment_generation?: string;
  readonly now?: () => number;
}): ResearchProjectModelConfigurationService {
  const { env: _env, ...implementationOptions } = options;
  void _env;
  return createConfigurationService(implementationOptions);
}

export function createResearchProjectModelConfigurationServiceFromEnv(
  env: Env,
  assertCurrentProjectAuthority?: AssertCurrentResearchProjectAuthority,
): ResearchProjectModelConfigurationService {
  if (env?.CORE_DB === undefined) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", 503, "Core D1 binding is unavailable");
  }
  return createResearchProjectModelConfigurationService({
    database: env.CORE_DB,
    env,
    native_model_authority: (context, projectId) => createOwnerResearchProviderNativeModelAuthority(env, context,
      projectId, ["CONFIGURATION_IMPORT", "SELECTION_READBACK", "COMPLETE"] satisfies readonly ResearchProviderKeyModelUseDbPhase[]),
    ...(assertCurrentProjectAuthority === undefined ? {} : { assertCurrentProjectAuthority }),
    deployment_environment: env.ENVIRONMENT === "development" ? "TEST" : "PRODUCTION",
    deployment_generation: env.DEPLOYMENT_GENERATION,
  });
}
