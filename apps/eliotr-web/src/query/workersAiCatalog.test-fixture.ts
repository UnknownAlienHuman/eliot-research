import { createResearchModelConfigurationApi, createSessionEpoch,
  type ServiceModelCatalogPage } from "@eliotr/owner-api-client";

/** Wire shape emitted by research-model-catalog.ts workersAiModel/pageResult. */
export const workersAiCatalogFixture = {
  protocol: "eliotr.service-model-catalog.v1", task: "text-generation", catalog_scope: "workers_ai",
  provider_id: "cloudflare-workers-ai",
  models: [{
    provider_id: "cloudflare-workers-ai", model_id: "@cf/zai-org/glm-5.3-flash", name: "GLM 5.3 Flash",
    description: "Text generation", catalog_availability: "listed", account_availability: "unknown",
    capabilities: { text_generation: "supported", input_output_schema: "not_exposed_by_workers_ai_binding",
      schema_requirement: "GET /client/v4/accounts/{account_id}/ai/models/schema?model={model_id}" },
    source_id: 1, source_task: { id: "Text Generation", name: "Text Generation", description: "Text generation" },
    billing: { selected_path: "workers_ai_binding", support: "unknown", account_entitlement: "not_established_by_catalog" },
    properties: [], tags: ["text-generation"],
  }],
  pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: "complete", probe: "next_page_empty" },
} as const satisfies ServiceModelCatalogPage;

/** Exercise the real request-selector mapping and strict response decoder. */
export async function readWorkersAiCatalogFixture() {
  const paths: string[] = [];
  const api = createResearchModelConfigurationApi({
    requestApiWithStatuses: async path => {
      paths.push(path);
      return { data: workersAiCatalogFixture, trace_id: "workers-ai-fixture", deployment_generation: "deployment-1" };
    },
  }, detail => new Error(detail.code), createSessionEpoch());
  const catalog = await api.readServiceModelCatalog("deployment-1", { providerId: "workers-ai" });
  return { catalog, paths };
}
