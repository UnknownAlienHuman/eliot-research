import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { createOwnerResearchProjectConfigurationService } from "./research-project-configuration-composition.js";
import {
  createResearchProviderKeyConfigurationComposition,
  installedGatewayIdentity,
} from "./research-provider-key-configuration-composition.js";
import { createResearchProviderKeyModelUseService } from "./research-provider-key-model-use-service.js";
import {
  ResearchProviderKeyConfigurationError,
  type ResearchProviderKeyConfigurationService,
} from "@eliotr/cloudflare-model-control";
import type { ServiceModelProviderService } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import { parseResearchPreparedModelTransportPolicies } from "@eliotr/cloudflare-model-control/research-prepared-model-transport-policies.js";
import { createServiceModelSettingsComposition } from "./service-model-settings-composition.js";

function configuredOpenRouterModels(env: Env): readonly string[] {
  const policies = parseResearchPreparedModelTransportPolicies(env.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON);
  return Object.freeze([...new Set((policies?.model_selections ?? [])
    .filter((selection) => selection.provider === "openrouter" &&
      selection.transport_policy.provider === "openrouter" && selection.transport_policy.billing.mode === "byok")
    .map((selection) => selection.model))]);
}

/**
 * The old project-key operation remains authoritative when present. A global
 * operation is only an in-memory read binding for the existing project-scoped
 * use ledger; it never creates or copies a project provider-key row.
 */
export function createGlobalServiceProviderKeyConfiguration(input: {
  readonly env: Env;
  readonly project_id: string;
  readonly project_configuration: ReturnType<typeof createOwnerResearchProjectConfigurationService>;
  readonly project_keys: ResearchProviderKeyConfigurationService;
  readonly service_models: ServiceModelProviderService;
}): ResearchProviderKeyConfigurationService {
  const gateway = installedGatewayIdentity(input.env.AI_GATEWAY_REASONING_URL);
  const preparedModels = configuredOpenRouterModels(input.env);
  return Object.freeze<ResearchProviderKeyConfigurationService>({
    read: (context, projectId, operationId) => input.project_keys.read(context, projectId, operationId),
    create: (context, projectId, request) => input.project_keys.create(context, projectId, request),
    async readConfiguredOperation(context, projectId, operationId) {
      if (projectId !== input.project_id) {
        throw new ResearchProviderKeyConfigurationError(
          "RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", 400,
          "Provider-key model use project does not match its composition",
        );
      }
      let missing: ResearchProviderKeyConfigurationError;
      try {
        return await input.project_keys.readConfiguredOperation(context, projectId, operationId);
      } catch (error) {
        if (!(error instanceof ResearchProviderKeyConfigurationError) ||
            error.code !== "RESEARCH_PROVIDER_KEY_CONFIGURATION_OPERATION_NOT_FOUND") throw error;
        missing = error;
      }

      // Exact project readback rechecks project authority before considering the
      // global connection. A pending/failed legacy project row never falls back.
      const projectStatus = await input.project_keys.read(context, projectId, operationId);
      if (projectStatus.truncated || projectStatus.configurations.length > 0) throw missing;
      const binding = await input.service_models.resolveConfiguredProvider(context, "openrouter", {
        operation_id: operationId,
      });
      if (binding === null) throw missing;
      if (gateway === undefined) {
        throw new ResearchProviderKeyConfigurationError(
          "RESEARCH_PROVIDER_KEY_CONFIGURATION_MANAGEMENT_UNAVAILABLE", 503,
          "The installed reasoning Gateway identity is unavailable", true,
        );
      }

      const selected = (await input.project_configuration.readPage(context, projectId, { limit: 1 })).selected;
      const selectedModels = selected?.model_selections
        .filter((selection) => selection.provider_id === "openrouter")
        .map((selection) => selection.model_id) ?? [];
      const requiredModels = [...new Set([...selectedModels, ...preparedModels])];
      if (requiredModels.length === 0 || requiredModels.some((model) => !binding.model_ids.includes(model))) {
        throw new ResearchProviderKeyConfigurationError(
          "RESEARCH_PROVIDER_KEY_CONFIGURATION_NOT_CONFIGURED", 409,
          "Global provider connection does not register every model selected by this model-use plan",
        );
      }
      return Object.freeze({
        owner_id: binding.owner_id,
        project_id: projectId,
        operation_id: binding.operation_id,
        provider_id: "openrouter",
        account_id: gateway.account_id,
        gateway_id: gateway.gateway_id,
        alias: binding.alias,
        provider_config_id: binding.provider_config_id,
        metadata_sha256: binding.metadata_sha256,
        status: "configured_not_qualified",
        created_at: binding.created_at,
      });
    },
  });
}

/** One authenticated owner/project context for key readback, Native probing, and config CAS. */
export function createResearchProviderKeyModelUseComposition(
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
) {
  const projectConfiguration = createOwnerResearchProjectConfigurationService(env, context, projectId);
  const keyConfiguration = createGlobalServiceProviderKeyConfiguration({
    env,
    project_id: projectId,
    project_configuration: projectConfiguration,
    project_keys: createResearchProviderKeyConfigurationComposition(env).service,
    service_models: createServiceModelSettingsComposition(env).service,
  });
  return createResearchProviderKeyModelUseService({
    env,
    context,
    project_id: projectId,
    key_configuration: keyConfiguration,
    project_configuration: projectConfiguration,
  });
}
