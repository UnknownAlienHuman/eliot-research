import type { ProjectClientGrantPut } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { createResearchClientExecutionEnvironment } from "./research-client-execution.js";
import type { ReauthenticatedRunRead } from "./research-run-read-authorization.js";
import type { ProjectClientRunRead } from "./research-client-run-read.js";
import {
  authorizeProjectClientSpend as authorizeProjectClientSpendCapability,
  prepareOwnerMachineRecoverySpend as prepareOwnerMachineRecoverySpendCapability,
  prepareProjectClientRecoverySpend as prepareProjectClientRecoverySpendCapability,
  requireProjectClientSpendSchema as requireProjectClientSpendSchemaCapability,
} from "@eliotr/cloudflare-research-runtime";
import type { ResearchClientSpendEnvironment } from "@eliotr/cloudflare-research-runtime";

export function createResearchClientSpendEnvironment(env: Env): ResearchClientSpendEnvironment {
  return {
    core_database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    ...(env.ELIOTR_MODEL_SPEND_POLICY_JSON === undefined ? {} : { model_spend_policy_json: env.ELIOTR_MODEL_SPEND_POLICY_JSON }),
    ...(env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF === undefined ? {} : {
      model_spend_policy_provenance_ref: env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF,
    }),
    client_execution: createResearchClientExecutionEnvironment(env),
  };
}

export function requireProjectClientSpendSchema(env: Env): Promise<void> {
  return requireProjectClientSpendSchemaCapability(createResearchClientSpendEnvironment(env));
}

export function authorizeProjectClientSpend(env: Env, context: AuthenticatedRequestContext, input: ProjectClientGrantPut) {
  return authorizeProjectClientSpendCapability(createResearchClientSpendEnvironment(env), context, input);
}

export function prepareProjectClientRecoverySpend(env: Env, read: ProjectClientRunRead) {
  return prepareProjectClientRecoverySpendCapability(createResearchClientSpendEnvironment(env), read);
}

export function prepareOwnerMachineRecoverySpend(
  env: Env, context: AuthenticatedRequestContext, read: ReauthenticatedRunRead,
) {
  return prepareOwnerMachineRecoverySpendCapability(createResearchClientSpendEnvironment(env), context, read);
}

export type { ProjectClientRecoverySpend } from "@eliotr/cloudflare-research-runtime";
