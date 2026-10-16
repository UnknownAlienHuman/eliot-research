import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createOwnerResearchProjectConfigurationService } from "./research-project-configuration-composition.js";
import { createResearchCatalogModelUseService } from "./research-catalog-model-use-service.js";
import { createResearchProviderKeyModelUseComposition } from "./research-provider-key-model-use-composition.js";
import type { ResearchCatalogModelUseV2Driver } from "./research-catalog-model-use-service.js";
import { createResearchCatalogModelUseV2Driver, createResearchCatalogModelUseV2PricingReader } from
  "./research-catalog-model-use-v2-driver.js";
import { createD1ProviderNativeModelCatalogV2Authority } from "@eliotr/cloudflare-native-models";
import type { ResearchProjectCatalogNativeModelV2AuthorityFactory } from "./research-project-configuration.js";
import type { Env } from "./env.js";
import { createResearchCatalogNativeBuiltinDriver } from "./research-catalog-native-builtin-driver.js";

/** Composition adapter for exact catalog selection over the existing owner/provider authorities. */
export function createResearchCatalogModelUseComposition(
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
  providerNativeV2?: ResearchCatalogModelUseV2Driver,
) {
  const authority = providerNativeV2?.authority ?? createD1ProviderNativeModelCatalogV2Authority({
    database: env.CORE_DB,
    pricing_snapshots: createResearchCatalogModelUseV2PricingReader({ database: env.CORE_DB }),
  });
  const catalogAuthorityFactory: ResearchProjectCatalogNativeModelV2AuthorityFactory = () => authority;
  const projectConfiguration = createOwnerResearchProjectConfigurationService(env, context, projectId,
    catalogAuthorityFactory);
  const modelUseV2 = providerNativeV2 ?? createResearchCatalogModelUseV2Driver({
    env, context, project_id: projectId, project_configuration: projectConfiguration, authority,
  });
  return createResearchCatalogModelUseService({
    env,
    context,
    project_id: projectId,
    project_configuration: projectConfiguration,
    model_use: (selection) => createResearchProviderKeyModelUseComposition(env, context, projectId, selection),
    provider_native_v2: modelUseV2,
    builtin_native: createResearchCatalogNativeBuiltinDriver({ env, context, project_id: projectId,
      project_configuration: projectConfiguration }),
  });
}
