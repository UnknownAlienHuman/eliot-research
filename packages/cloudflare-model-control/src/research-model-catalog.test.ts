import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  createResearchModelCatalogService,
  ResearchModelCatalogError,
  RESEARCH_MODEL_CATALOG_PROTOCOL,
  SERVICE_MODEL_CATALOG_PROTOCOL,
  type ExternalProviderCatalogTransport,
  type ResearchModelCatalogQuery,
  type WorkersAiModelCatalogBinding,
} from "./research-model-catalog.js";
import { createResearchProviderModelCatalogTransports } from "./research-provider-model-catalog.js";
import type { ConfiguredServiceModelProviderBinding } from "./service-model-provider-service.js";

function ownerContext(overrides: Partial<AuthenticatedRequestContext> = {}): AuthenticatedRequestContext {
  return {
    request: new Request("https://research.test/api/projects/project-1/models"),
    principal_ref: "owner-1",
    client_class: "owner_pwa",
    credential_generation: "credential-1",
    trace_id: "trace-1",
    access: { principal_ref: "owner-1", credential_generation: "credential-1", expires_at: "2099-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

function database(owned: boolean): D1Database {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => owned ? { owned: 1 } : null),
  };
  return { prepare: vi.fn(() => statement) } as unknown as D1Database;
}

function workersModel(id: string, task = "Text Generation"): Record<string, unknown> {
  return {
    id,
    source: 1,
    name: `Model ${id}`,
    description: "Supports UTF-8: 日本語, español, Ελληνικά.",
    task: { id: task, name: task, description: "Text generation" },
    tags: ["text-generation"],
    properties: [
      { property_id: "reasoning_effort", value: {
        supported_efforts: ["max", "high", "low"], default_effort: "max",
        normalizes_to: { none: "max", medium: "max", xhigh: "max" },
      } },
      { property_id: "price", value: [{ unit: "tokens", price: 0.2 }] },
    ],
  };
}

function binding(models: ReturnType<typeof vi.fn>): WorkersAiModelCatalogBinding {
  return { models } as unknown as WorkersAiModelCatalogBinding;
}

describe("research model catalog", () => {
  it("lists built-in models for global Settings without consulting any project or D1", async () => {
    const db = database(false);
    const aiModels = vi.fn(async ({ page }: AiModelsSearchParams) => page === 1 ? [workersModel("@cf/zai-org/glm-5.3-flash")] : []);
    const service = createResearchModelCatalogService({ database: db, workersAi: binding(aiModels) });

    const result = await service.listWorkersAiForService(ownerContext());

    expect(result.protocol).toBe(SERVICE_MODEL_CATALOG_PROTOCOL);
    expect(result).not.toHaveProperty("project_id");
    expect(result.models[0]?.model_id).toBe("@cf/zai-org/glm-5.3-flash");
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("requires an authenticated owner for global catalogs before database or provider calls", async () => {
    const db = database(false), aiModels = vi.fn(async () => []);
    const service = createResearchModelCatalogService({ database: db, workersAi: binding(aiModels) });

    await expect(service.listWorkersAiForService(ownerContext({ client_class: "trusted_agent" })))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_OWNER_REQUIRED", status: 403 });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(aiModels).not.toHaveBeenCalled();
  });

  it("lists a bounded Workers AI text-generation page and confirms the next page", async () => {
    const aiModels = vi.fn(async (input: { page?: number } = {}) =>
      input.page === 1 ? [workersModel("@cf/example/alpha")] : [workersModel("@cf/example/beta")]);
    const service = createResearchModelCatalogService({ database: database(true), workersAi: binding(aiModels) });

    const result = await service.listWorkersAi(ownerContext(), "project-1", {
      search: "模型 español", page: 1, per_page: 1, task: "text-generation",
    });

    expect(aiModels).toHaveBeenCalledTimes(2);
    expect(aiModels.mock.calls.map(([input]) => input)).toEqual([
      { page: 1, per_page: 1, task: "Text Generation", search: "模型 español" },
      { page: 2, per_page: 1, task: "Text Generation", search: "模型 español" },
    ]);
    expect(result.protocol).toBe(RESEARCH_MODEL_CATALOG_PROTOCOL);
    expect(result.models[0]).toMatchObject({
      provider_id: "cloudflare-workers-ai",
      model_id: "@cf/example/alpha",
      account_availability: "unknown",
      capabilities: {
        text_generation: "supported",
        input_output_schema: "not_exposed_by_workers_ai_binding",
        schema_requirement: "GET /client/v4/accounts/{account_id}/ai/models/schema?model={model_id}",
      },
      billing: { selected_path: "workers_ai_binding", support: "unknown", account_entitlement: "not_established_by_catalog" },
    });
    expect(result.models[0]?.properties[0]?.value).toMatchObject({ supported_efforts: ["max", "high", "low"] });
    expect(result.models[0]?.properties[1]?.value).toEqual([{ unit: "tokens", price: 0.2 }]);
    expect(result.pagination).toEqual({
      page: 1, per_page: 1, has_more: true, next_page: 2, coverage: "partial", probe: "next_page_non_empty",
    });
  });

  it("does not read a catalog until the authenticated principal owns the project", async () => {
    const aiModels = vi.fn(async () => []);
    const service = createResearchModelCatalogService({ database: database(false), workersAi: binding(aiModels) });

    await expect(service.listWorkersAi(ownerContext(), "project-1")).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROJECT_NOT_FOUND", status: 404,
    });
    expect(aiModels).not.toHaveBeenCalled();
  });

  it("rejects a non-owner or mismatched authenticated identity before database or catalog access", async () => {
    const db = database(true);
    const aiModels = vi.fn(async () => []);
    const service = createResearchModelCatalogService({ database: db, workersAi: binding(aiModels) });

    await expect(service.listWorkersAi(ownerContext({ client_class: "trusted_agent" }), "project-1"))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_OWNER_REQUIRED", status: 403 });
    await expect(service.listWorkersAi(ownerContext({ access: {
      principal_ref: "another-owner", credential_generation: "credential-1", expires_at: "2099-01-01T00:00:00.000Z",
    } }), "project-1"))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_OWNER_REQUIRED", status: 403 });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(aiModels).not.toHaveBeenCalled();
  });

  it("rejects oversized Unicode searches, invalid pages, and unknown query fields", async () => {
    const service = createResearchModelCatalogService({ database: database(true), workersAi: binding(vi.fn()) });
    const invalidQueries: unknown[] = [
      { search: "界".repeat(200) }, { page: 0 }, { per_page: 51 }, { provider: "openai" }, { task: "embeddings" },
    ];
    for (const query of invalidQueries) {
      await expect(service.listWorkersAi(ownerContext(), "project-1", query as ResearchModelCatalogQuery))
        .rejects.toMatchObject({ code: "MODEL_CATALOG_REQUEST_INVALID", status: 400 });
    }
  });

  it("fails closed on malformed or non-text-generation Workers AI results", async () => {
    for (const malformed of [
      { ...workersModel("@cf/example/alpha"), task: { id: "Embeddings", name: "Embeddings", description: "" } },
      { ...workersModel("@cf/example/alpha"), properties: [{ property_id: "bad", value: new Date() }] },
    ]) {
      const aiModels = vi.fn(async (input: { page?: number } = {}) => input.page === 1 ? [malformed] : []);
      const service = createResearchModelCatalogService({ database: database(true), workersAi: binding(aiModels) });
      await expect(service.listWorkersAi(ownerContext(), "project-1"))
        .rejects.toMatchObject({ code: "MODEL_CATALOG_RESPONSE_INVALID", status: 502 });
    }
  });

  it("reports incomplete coverage when the array-only binding cannot probe the next page", async () => {
    const aiModels = vi.fn(async (input: { page?: number } = {}) => {
      if (input.page === 1) return [workersModel("@cf/example/alpha")];
      throw new Error("transient catalog failure");
    });
    const service = createResearchModelCatalogService({ database: database(true), workersAi: binding(aiModels) });

    const result = await service.listWorkersAi(ownerContext(), "project-1", { page: 1, per_page: 1 });

    expect(result.models).toHaveLength(1);
    expect(result.pagination).toEqual({
      page: 1, per_page: 1, has_more: null, next_page: null, coverage: "unknown", probe: "next_page_unavailable",
    });
  });

  it("does not invent external provider catalogs and keeps their billing/capability data separate", async () => {
    const listTextGeneration = vi.fn(async () => ({
      models: [{
        model_id: "vendor/model-1", name: "External model", description: "Vendor listing",
        text_generation: "unknown" as const, billing_support: "byok" as const, properties: [], tags: [],
      }],
      has_more: null,
    }));
    const provider: ExternalProviderCatalogTransport = { provider_id: "vendor", listTextGeneration };
    const service = createResearchModelCatalogService({ database: database(true), externalProviders: [provider] });

    await expect(service.listExternalProvider(ownerContext(), "project-1", "missing"))
      .rejects.toBeInstanceOf(ResearchModelCatalogError);
    const result = await service.listExternalProvider(ownerContext(), "project-1", "vendor");
    expect(listTextGeneration).toHaveBeenCalledWith({ page: 1, per_page: 20, task: "text-generation", signal: expect.any(AbortSignal) });
    expect(result.catalog_scope).toBe("external_provider");
    expect(result.models[0]).toMatchObject({
      provider_id: "vendor",
      capabilities: { text_generation: "unknown", input_output_schema: "unknown" },
      billing: { selected_path: "provider_catalog", support: "byok" },
    });
    expect(result.pagination).toMatchObject({ has_more: null, coverage: "unknown", probe: "next_page_unavailable" });
  });

  it("uses the owner-resolved global alias and exposes only globally registered OpenRouter models", async () => {
    const modelId = "dots-studio/dots-3-note-preview:free";
    const binding: ConfiguredServiceModelProviderBinding = Object.freeze({
      owner_id: "owner-1",
      operation_id: "a9f79914-a0a5-4f27-9e81-3b9b6c403a61",
      provider_id: "openrouter",
      provider_slug: "openrouter",
      model_ids: Object.freeze([modelId]),
      alias: "eliotr-" + "a".repeat(48),
      provider_config_id: "provider-config-1",
      metadata_sha256: "b".repeat(64),
      created_at: "2026-10-15T14:00:00.000Z",
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      data: [
        { id: modelId, architecture: { output_modalities: ["text"] } },
        { id: "another/model:free", architecture: { output_modalities: ["text"] } },
      ],
      links: {},
      total_count: 2,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const transports = createResearchProviderModelCatalogTransports({
      gateway_base_url: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`,
      gateway_token: "server-held-test-gateway-token",
      fetcher: fetcher as typeof fetch,
      resolve_service_provider: vi.fn(async (provider) => provider === "openrouter" ? binding : null),
    });
    const openRouter = transports.find((provider) => provider.provider_id === "openrouter");

    const page = await openRouter?.listTextGeneration({ page: 1, per_page: 20, task: "text-generation" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("cf-aig-byok-alias")).toBe(binding.alias);
    expect(page?.models.map((model) => model.model_id)).toEqual([modelId]);
    expect(page?.has_more).toBeNull();
  });

  it("requires the owner/project check before reporting a missing Workers AI binding", async () => {
    const db = database(true);
    const service = createResearchModelCatalogService({ database: db });
    await expect(service.listWorkersAi(ownerContext(), "project-1"))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_WORKERS_AI_UNAVAILABLE", status: 503 });
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });
});
