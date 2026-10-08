import type { ScopeSnapshot } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import type { EvidenceAccessContext, NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { WorkflowPrincipal, ResearchModelSpendPolicy } from "@eliotr/cloudflare-research";
import type { createProjectClientScopeAuthority } from "@eliotr/cloudflare-navigation";
import type { Env } from "./env.js";
import {
  prepareClientResearchAdmission as prepareClientResearchAdmissionCapability,
  requireClientResearchExecution as requireClientResearchExecutionCapability,
  loadResearchExecutionAccess as loadResearchExecutionAccessCapability,
  resolveResearchExecutionSpend as resolveResearchExecutionSpendCapability,
} from "@eliotr/cloudflare-research-runtime";
import type { ResearchSponsoredRun } from "@eliotr/cloudflare-research-runtime";

export function createResearchClientExecutionEnvironment(env: Env) {
  return {
    core_database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    ...(env.ELIOTR_MODEL_SPEND_POLICY_JSON === undefined ? {} : { owner_spend_policy_json: env.ELIOTR_MODEL_SPEND_POLICY_JSON }),
    ...(env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF === undefined ? {} : {
      owner_spend_policy_provenance_ref: env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF,
    }),
  };
}

export function prepareClientResearchAdmission(
  env: Env, context: AuthenticatedRequestContext, request: QueryRequest, operationId: string,
): Promise<Awaited<ReturnType<typeof createProjectClientScopeAuthority>>> {
  return prepareClientResearchAdmissionCapability(createResearchClientExecutionEnvironment(env), context, request, operationId);
}

export function requireClientResearchExecution(
  env: Env, access: EvidenceAccessContext, scope: Pick<ScopeSnapshot, "snapshot_id" | "revision">,
  operationId: string, deployment: string,
): Promise<ResearchSponsoredRun> {
  return requireClientResearchExecutionCapability(
    createResearchClientExecutionEnvironment(env), access, scope, operationId, deployment,
  );
}

export function loadResearchExecutionAccess(env: Env, operationId: string, principal: WorkflowPrincipal) {
  return loadResearchExecutionAccessCapability(createResearchClientExecutionEnvironment(env), operationId, principal);
}

export function resolveResearchExecutionSpend(
  env: Env, navigation: NavigationReadAuthority, operationId: string, deployment: string, policyGeneration: string,
): Promise<ResearchModelSpendPolicy> {
  return resolveResearchExecutionSpendCapability(
    createResearchClientExecutionEnvironment(env), navigation, operationId, deployment, policyGeneration,
  );
}
