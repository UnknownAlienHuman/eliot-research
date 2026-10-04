import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ProviderNativeModelAuthorityPort } from "@eliotr/cloudflare-native-models";
import {
  readResearchConfigurationReadiness as readConfigurationReadiness,
  type ResearchConfigurationReadiness,
  type ResearchQualificationReadiness,
  type ResearchRunReadiness,
  type ResearchConfigurationReadinessReason,
} from "@eliotr/cloudflare-research-configuration/research-configuration-readiness.js";
import type { ResearchRunModelSelection } from "./research-run-configuration.js";
import { researchConfigurationRuntimeValuesFromEnv } from "./research-configuration-status.js";
import type { Env } from "./env.js";

export type {
  ResearchConfigurationReadiness,
  ResearchQualificationReadiness,
  ResearchRunReadiness,
  ResearchConfigurationReadinessReason,
};

/** Core adapter supplies D1, installed semantic values, and the gateway-read capability. */
export function readResearchConfigurationReadiness(
  env: Env,
  owner: Pick<AuthenticatedRequestContext, "principal_ref" | "credential_generation" | "client_class">,
  options: Readonly<{
    readonly selected_model_selections?: readonly ResearchRunModelSelection[];
    readonly mode?: "snapshot-v1" | "snapshot-v2";
    readonly project_owner_ref?: string;
    readonly project_id?: string;
    readonly native_model_authority?: ProviderNativeModelAuthorityPort;
  }> = {},
): Promise<ResearchConfigurationReadiness> {
  const deploymentGeneration = env.DEPLOYMENT_GENERATION;
  const modelGatewayReadToken = env.ELIOTR_MODEL_GATEWAY_READ_TOKEN;
  return readConfigurationReadiness({ database: env.CORE_DB,
    configuration: researchConfigurationRuntimeValuesFromEnv(env),
    ...(deploymentGeneration === undefined ? {} : { deployment_generation: deploymentGeneration }),
    ...(modelGatewayReadToken === undefined ? {} : { model_gateway_read_token: modelGatewayReadToken }) }, owner, options);
}
