import {
  createResearchSemanticNativeModelRuntime as composeNativeRuntime,
  prepareResearchSemanticNativeModelRunContext,
} from "@eliotr/cloudflare-research-runtime/research-semantic-native-model-runtime.js";
import { createResearchProviderNativeModelAuthority } from "./research-provider-native-model-authority.js";
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
}>) {
  const context = prepareResearchSemanticNativeModelRunContext({
    run_configuration: input.run_configuration,
    owner_ref: input.owner_ref,
  });
  const authority = context === undefined ? undefined : createResearchProviderNativeModelAuthority({
    env: input.env,
    current_scope: createResearchProviderNativeModelCurrentScopeReader({
      database: input.env.CORE_DB,
      owner_ref: context.project_owner_ref,
      project_id: context.project_id,
      model_selections: [...context.selections.values()],
    }),
  });
  return composeNativeRuntime({ context, authority });
}
