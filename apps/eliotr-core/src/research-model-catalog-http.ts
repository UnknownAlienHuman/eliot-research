import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { apiResult, HttpRequestError } from "./http.js";
import { createResearchModelCatalogService, ResearchModelCatalogError } from "@eliotr/cloudflare-model-control/research-model-catalog.js";
import { createResearchProviderModelCatalogTransports } from "@eliotr/cloudflare-model-control/research-provider-model-catalog.js";
import type { Env } from "./env.js";

/** The catalog is descriptive; this read never installs or qualifies a model. */
export async function handleResearchModelCatalog(
  request: Request, env: Env, context: AuthenticatedRequestContext,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const allowed = new Set(["project_id", "provider_id", "search", "page", "per_page", "task"]);
  for (const key of query.keys()) {
    if (!allowed.has(key) || query.getAll(key).length !== 1) {
      throw new HttpRequestError("MODEL_CATALOG_REQUEST_INVALID", 400, "Model catalog query is invalid");
    }
  }
  const projectId = query.get("project_id");
  if (!projectId) throw new HttpRequestError("MODEL_CATALOG_PROJECT_INVALID", 400, "Select a project for model configuration");
  const task = query.get("task");
  if (task !== null && task !== "text-generation") {
    throw new HttpRequestError("MODEL_CATALOG_REQUEST_INVALID", 400, "Only the text generation catalog is supported");
  }
  const number = (key: string): number | undefined => {
    const value = query.get(key);
    if (value === null) return undefined;
    if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new HttpRequestError("MODEL_CATALOG_REQUEST_INVALID", 400, "Model catalog pagination is invalid");
    }
    return Number(value);
  };
  const search = query.get("search");
  const page = number("page"), perPage = number("per_page");
  const input = {
    ...(search === null ? {} : { search }),
    ...(page === undefined ? {} : { page }),
    ...(perPage === undefined ? {} : { per_page: perPage }),
    task: "text-generation" as const,
  };
  const workersAi = typeof env.AI?.models === "function" ? env.AI as Pick<Ai, "models"> : undefined;
  const service = createResearchModelCatalogService({ database: env.CORE_DB,
    ...(workersAi === undefined ? {} : { workersAi }),
    externalProviders: createResearchProviderModelCatalogTransports({
      gateway_base_url: env.AI_GATEWAY_REASONING_URL,
      ...(env.ELIOTR_MODEL_GATEWAY_TOKEN === undefined ? {} : { gateway_token: env.ELIOTR_MODEL_GATEWAY_TOKEN }),
      ...(env.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON === undefined ? {} : {
        prepared_transport_policies_json: env.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON,
      }),
    }),
  });
  const providerId = query.get("provider_id");
  try {
    const result = providerId === null || providerId === "cloudflare-workers-ai"
      ? await service.listWorkersAi(context, projectId, input)
      : await service.listExternalProvider(context, projectId, providerId, input);
    return apiResult(request, env, result);
  } catch (error) {
    if (error instanceof ResearchModelCatalogError) {
      throw new HttpRequestError(error.code, error.status, error.message, error.retryable);
    }
    throw error;
  }
}
