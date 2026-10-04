import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readResearchModelCatalog,
  readResearchProjectModelConfiguration,
  researchModelCatalogAdapterForRouteProvider,
  researchModelBillingLabel,
  researchModelSelectionEffectiveEffortLabel,
  selectResearchProjectModelConfiguration,
  type ResearchModelSelectionSummary,
  type ResearchModelCatalogEntry,
  type ResearchModelConfigurationRevision,
} from "./research-model-configuration-api.js";

const projectId = "project-1";
const generation = "deploy-1";
const traceId = "trace-1";
const digest = "a".repeat(64);

function envelope(data: unknown, deploymentGeneration = generation): unknown {
  return { data, trace_id: traceId, deployment_generation: deploymentGeneration };
}

function apiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return apiResponse(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function catalogEntry(overrides: Partial<ResearchModelCatalogEntry> = {}): ResearchModelCatalogEntry {
  return {
    provider_id: "cloudflare-workers-ai",
    model_id: "@cf/example/model",
    name: "Example model",
    description: "A catalog entry.",
    catalog_availability: "listed",
    account_availability: "unknown",
    capabilities: {
      text_generation: "supported",
      input_output_schema: "not_exposed_by_workers_ai_binding",
      schema_requirement: "GET /client/v4/accounts/{account_id}/ai/models/schema?model={model_id}",
    },
    source_id: 7,
    source_task: { id: "text-generation", name: "Text Generation", description: "Generate text" },
    billing: { selected_path: "workers_ai_binding", support: "unknown", account_entitlement: "not_established_by_catalog" },
    properties: [],
    tags: ["text-generation"],
    ...overrides,
  };
}

function modelSelection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: "SYNTHESIZE",
    route_ref: "route/research",
    route_version: "v1",
    candidate_ref: "candidate-1",
    candidate_sha256: digest,
    qualification_ref: "qualification-1",
    qualification_sha256: "b".repeat(64),
    provider_id: "openai",
    model_id: "glm-5.3-flash",
    effective_reasoning_effort: "max",
    transport_policy: {
      version: 1,
      transport: "cloudflare-ai-gateway",
      api: "compat-chat-completions",
      provider: "openai",
      model: "glm-5.3-flash",
      billing: { mode: "byok", alias: "default" },
      capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["max", "high", "low"] },
    },
    ...overrides,
  };
}

function revision(overrides: Record<string, unknown> = {}): ResearchModelConfigurationRevision {
  return {
    configuration_ref: "model-config-1",
    configuration_sha256: digest,
    created_at: "2026-10-03T12:00:00.000Z",
    qualification_state: "qualified",
    semantic_revision: { revision_ref: "semantic-1", config_sha256: "c".repeat(64) },
    model_selections: [modelSelection() as unknown as ResearchModelSelectionSummary],
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("project model configuration API", () => {
  it("maps the canonical Workers AI route provider to the catalog adapter without aliasing other providers", async () => {
    expect(researchModelCatalogAdapterForRouteProvider("workers-ai")).toBe("cloudflare-workers-ai");
    expect(researchModelCatalogAdapterForRouteProvider("openai")).toBe("openai");
    const fetchMock = installFetch(envelope({
      protocol: "eliotr.research-model-catalog.v1", project_id: projectId, task: "text-generation",
      catalog_scope: "workers_ai", provider_id: "cloudflare-workers-ai", models: [catalogEntry()],
      pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: "complete", probe: "next_page_empty" },
    }));

    const result = await readResearchModelCatalog(projectId, generation, { providerId: "workers-ai" });

    const request = fetchMock.mock.calls[0]?.[0] as string;
    expect(request).toContain("provider_id=cloudflare-workers-ai");
    expect(request).not.toContain("provider_id=workers-ai");
    expect(result.provider_id).toBe("cloudflare-workers-ai");
  });

  it("decodes catalog availability, capability, billing, and pagination as separate facts", async () => {
    const entry = catalogEntry();
    const fetchMock = installFetch(envelope({
      protocol: "eliotr.research-model-catalog.v1",
      project_id: projectId,
      task: "text-generation",
      catalog_scope: "workers_ai",
      provider_id: "cloudflare-workers-ai",
      models: [entry],
      pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: "complete", probe: "next_page_empty" },
    }));

    const result = await readResearchModelCatalog(projectId, generation);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0] as string;
    expect(request).toContain("project_id=project-1");
    expect(request).toContain("task=text-generation");
    expect(result.models[0]).toMatchObject({ catalog_availability: "listed", account_availability: "unknown",
      capabilities: { text_generation: "supported" }, billing: { support: "unknown", account_entitlement: "not_established_by_catalog" } });
  });

  it("rejects a catalog response for another project or deployment generation", async () => {
    installFetch(envelope({
      protocol: "eliotr.research-model-catalog.v1", project_id: "another-project", task: "text-generation",
      catalog_scope: "workers_ai", provider_id: "cloudflare-workers-ai", models: [],
      pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: "complete", probe: "next_page_empty" },
    }));
    await expect(readResearchModelCatalog(projectId, generation)).rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    installFetch(envelope({
      protocol: "eliotr.research-model-catalog.v1", project_id: projectId, task: "text-generation",
      catalog_scope: "workers_ai", provider_id: "cloudflare-workers-ai", models: [],
      pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: "complete", probe: "next_page_empty" },
    }, "deploy-2"));
    await expect(readResearchModelCatalog(projectId, generation)).rejects.toMatchObject({ code: "API_GENERATION_MISMATCH" });
  });

  it("reads only exact saved project revisions and retains BYOK alias without key material", async () => {
    const saved = revision();
    installFetch(envelope({
      protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId, selection_revision: 3,
      selected: saved, revisions: [saved], next_cursor: null,
    }));

    const result = await readResearchProjectModelConfiguration(projectId, generation);

    expect(result.selection_revision).toBe(3);
    expect(result.selected?.model_selections[0]?.transport_policy.billing).toEqual({ mode: "byok", alias: "default" });
    expect(result.selected?.model_selections[0]?.effective_reasoning_effort).toBe("max");
    const selected = result.selected;
    const selection = selected?.model_selections[0];
    if (!selection) throw new Error("decoded project configuration did not include its selected model");
    expect(researchModelSelectionEffectiveEffortLabel(selection)).toBe("Effective reasoning effort: max");
    expect(JSON.stringify(result)).not.toContain("api_key");
    expect(researchModelBillingLabel(catalogEntry())).toContain("account entitlement not established by catalog");
  });

  it("keeps a missing legacy effort unknown instead of deriving it from transport capabilities", async () => {
    const legacySelection = modelSelection();
    delete legacySelection.effective_reasoning_effort;
    const saved = revision({ model_selections: [legacySelection as unknown as ResearchModelConfigurationRevision["model_selections"][number]] });
    installFetch(envelope({
      protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId, selection_revision: 3,
      selected: saved, revisions: [saved], next_cursor: null,
    }));

    const result = await readResearchProjectModelConfiguration(projectId, generation);
    const selection = result.selected?.model_selections[0];
    if (!selection) throw new Error("decoded project configuration did not include its selected model");

    expect(selection.transport_policy.capabilities.reasoning_efforts).toContain("max");
    expect(selection.effective_reasoning_effort).toBeNull();
    expect(researchModelSelectionEffectiveEffortLabel(selection)).toBe("Effective reasoning effort: unspecified in this saved configuration");
  });

  it("keeps historical qualifications readable while identifying them as unavailable for selection", async () => {
    const historical = revision({ qualification_state: "qualification_required" });
    installFetch(envelope({
      protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId, selection_revision: 3,
      selected: historical, revisions: [historical], next_cursor: null,
    }));

    const result = await readResearchProjectModelConfiguration(projectId, generation);

    expect(result.selected?.qualification_state).toBe("qualification_required");
    expect(result.revisions[0]?.qualification_state).toBe("qualification_required");
  });

  it("rejects an unknown saved qualification state", async () => {
    const malformed = revision({ qualification_state: "maybe-qualified" });
    installFetch(envelope({
      protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId, selection_revision: 3,
      selected: malformed, revisions: [malformed], next_cursor: null,
    }));

    await expect(readResearchProjectModelConfiguration(projectId, generation))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
  });

  it("selects only a returned saved ref with compare-and-swap and checks the exact receipt", async () => {
    const saved = revision();
    const fetchMock = installFetch(envelope({
      protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId,
      selection_revision: 4, selected: saved,
    }));

    const result = await selectResearchProjectModelConfiguration(projectId, generation, 3, "model-config-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/research/projects/project-1/model-configuration");
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({ "content-type": "application/json", "x-eliotr-csrf": "1" });
    expect(JSON.parse(String(init.body))).toEqual({ expected_revision: 3, select_configuration_ref: "model-config-1" });
    expect(result.selected.configuration_ref).toBe("model-config-1");
  });

  it("rejects an unrecognized transport-policy field instead of displaying guessed behavior", async () => {
    const saved = revision({ model_selections: [modelSelection({ transport_policy: {
      version: 1, transport: "cloudflare-ai-gateway", api: "compat-chat-completions", provider: "openai",
      model: "glm-5.3-flash",
      billing: { mode: "unified" }, capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["max"] },
      fallback_to_unified_billing: true,
    } })] });
    installFetch(envelope({
      protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId, selection_revision: 3,
      selected: saved, revisions: [saved], next_cursor: null,
    }));

    await expect(readResearchProjectModelConfiguration(projectId, generation)).rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
  });

  it("rejects transport model mismatches and blank model IDs", async () => {
    const mismatch = revision({ model_selections: [modelSelection({ transport_policy: {
      version: 1, transport: "cloudflare-ai-gateway", api: "compat-chat-completions", provider: "openai",
      model: "another-model", billing: { mode: "unified" },
      capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["max"] },
    } }) as unknown as ResearchModelConfigurationRevision["model_selections"][number]] });
    installFetch(envelope({
      protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId, selection_revision: 3,
      selected: mismatch, revisions: [mismatch], next_cursor: null,
    }));
    await expect(readResearchProjectModelConfiguration(projectId, generation)).rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });

    const blank = revision({ model_selections: [modelSelection({ model_id: " " , transport_policy: {
      version: 1, transport: "cloudflare-ai-gateway", api: "compat-chat-completions", provider: "openai",
      model: " ", billing: { mode: "unified" }, capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: [] },
    } }) as unknown as ResearchModelConfigurationRevision["model_selections"][number]] });
    installFetch(envelope({
      protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId, selection_revision: 3,
      selected: blank, revisions: [blank], next_cursor: null,
    }));
    await expect(readResearchProjectModelConfiguration(projectId, generation)).rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
  });
});
