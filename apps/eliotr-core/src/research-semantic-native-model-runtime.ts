import {
  createResearchSemanticNativeModelRuntime as composeNativeRuntime,
  prepareResearchSemanticNativeModelRunContext,
} from "@eliotr/cloudflare-research-runtime/research-semantic-native-model-runtime.js";
import { createResearchProviderNativeModelAuthority } from "./research-provider-native-model-authority.js";
import { createD1ProviderNativeModelCatalogV2Authority,
  type ProviderNativeModelCatalogV2PricingReader } from "@eliotr/cloudflare-native-models";
import { createResearchProviderNativeModelCurrentScopeReader } from "./research-provider-native-model-current-scope.js";
import type { Env } from "./env.js";
import type { ResearchRunModelSelection } from "./research-run-configuration.js";

interface NativeRunConfiguration {
  readonly mode: "legacy-installed" | "snapshot-v1" | "snapshot-v2";
  readonly configuration_ref?: string | null;
  readonly configuration_sha256?: string | null;
  readonly project_owner_ref?: string | null;
  readonly project_id?: string | null;
  readonly model_selections?: readonly ResearchRunModelSelection[];
}

/** Core keeps the Worker Env and live D1 current-scope authority at the composition boundary. */
export function createResearchSemanticNativeModelRuntime(input: Readonly<{
  env: Pick<Env, "CORE_DB" | "AI_GATEWAY_REASONING_URL">;
  run_configuration: NativeRunConfiguration | undefined;
  owner_ref: string;
  catalog_pricing_snapshots?: ProviderNativeModelCatalogV2PricingReader;
}>) {
  const context = prepareResearchSemanticNativeModelRunContext({
    run_configuration: input.run_configuration,
    owner_ref: input.owner_ref,
  });
  const hasV1 = context !== undefined && [...context.selections.values()].some((selection) => selection.candidate_kind === "provider-native-v1");
  const hasV2 = context !== undefined && [...context.selections.values()].some((selection) => selection.candidate_kind === "provider-native-v2");
  const authority = !hasV1 ? undefined : createResearchProviderNativeModelAuthority({
    env: input.env,
    current_scope: createResearchProviderNativeModelCurrentScopeReader({
      database: input.env.CORE_DB,
      owner_ref: context.project_owner_ref,
      project_id: context.project_id,
      model_selections: [...context.selections.values()],
    }),
  });
  if (hasV2 && input.catalog_pricing_snapshots === undefined) {
    throw new Error("Trusted catalog pricing and SDK capability resolver is required for provider-native v2 run pins");
  }
  const catalogAuthority = !hasV2 ? undefined : createD1ProviderNativeModelCatalogV2Authority({
    database: input.env.CORE_DB,
    pricing_snapshots: input.catalog_pricing_snapshots as ProviderNativeModelCatalogV2PricingReader,
  });
  return composeNativeRuntime({ context, authority, catalog_authority: catalogAuthority });
}
