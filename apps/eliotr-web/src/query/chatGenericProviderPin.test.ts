import { describe, expect, it, vi } from "vitest";
import { createResearchRunsApi, createSessionEpoch, type ResearchProjectModelConfiguration } from "@eliotr/owner-api-client";
import { chatCatalogProviderForRouteProvider } from "./chatModelProviderIdentity";
import { configurationMatchesChatModel, prepareChatModelRunV4 } from "./chatModelSelection";
import { preferredChatModelIdentity } from "./chatModelCatalog";

const provider = `compatible-${"a".repeat(24)}`, physical = `custom-${provider}`, model = "vendor/model";
const sha = "b".repeat(64);
const selected: NonNullable<ResearchProjectModelConfiguration["selected"]> = {
  configuration_ref: `rpmc-${sha}`, configuration_sha256: sha, qualification_state: "qualified", created_at: "2026-10-16T00:00:00.000Z",
  semantic_revision: { revision_ref: "semantic-1", config_sha256: "c".repeat(64) }, model_selections: [{ candidate_kind: "provider-native-v2",
    stage: "SYNTHESIZE", route_ref: "route/research", route_version: "v1", candidate_ref: "candidate-1", candidate_sha256: "d".repeat(64),
    qualification_ref: "qualification-1", qualification_sha256: "e".repeat(64), provider_id: physical, model_id: model,
    effective_reasoning_effort: null, transport_policy: { version: 1, transport: "cloudflare-ai-gateway", api: "custom-chat-completions",
      provider: physical, model, billing: { mode: "byok", alias: "saved-alias" }, capabilities: { max_output_tokens_field: "max_tokens",
        reasoning_efforts: [], response_format_normalization: "json-schema-to-json-object" } } }],
};
const configuration: ResearchProjectModelConfiguration = { protocol: "eliotr.research-project-model-configuration.v1",
  project_id: "project-1", selected, revisions: [selected], selection_revision: 7, next_cursor: null };

describe("exact generic provider chat pins", () => {
  it("prepares the existing qualified pin using the exact logical catalog pair without changing selection", async () => {
    const choice = { provider_id: provider, model_id: model };
    expect(preferredChatModelIdentity(configuration, "native-default")).toEqual(choice);
    expect(configurationMatchesChatModel(selected, choice)).toBe(true);
    const models = { readResearchProjectModelConfiguration: vi.fn().mockResolvedValue(configuration), selectResearchProjectModelConfiguration: vi.fn() };
    const runs = createResearchRunsApi({ epoch: createSessionEpoch(), errors: error => new Error(error.code),
      request: async () => { throw new Error("No run dispatch"); } });
    const result = await prepareChatModelRunV4({ models: models as never, runs, projectId: configuration.project_id,
      generation: "deployment-1", candidate: selected, modelChoice: choice, signal: new AbortController().signal, isCurrent: () => true,
      mintSelectionOperation: () => { throw new Error("Must retain selected pin"); },
      request: { query: "Read the selected sources", scope_expression: { kind: "PROJECT", project_id: configuration.project_id } } });
    expect(JSON.parse(result.body).selection).toEqual({ configuration_project_id: configuration.project_id,
      configuration_ref: selected.configuration_ref, configuration_sha256: sha, selection_revision: 7 });
    expect(models.selectResearchProjectModelConfiguration).not.toHaveBeenCalled();
  });

  it("rejects another connection, model or unrecognized physical prefix", () => {
    expect(configurationMatchesChatModel(selected, { provider_id: `compatible-${"f".repeat(24)}`, model_id: model })).toBe(false);
    expect(configurationMatchesChatModel(selected, { provider_id: provider, model_id: "vendor/other" })).toBe(false);
    for (const value of ["custom-compatible-unknown", `custom-custom-${provider}`, "custom-unknown-provider"])
      expect(chatCatalogProviderForRouteProvider(value)).toBe(value);
  });

  it("rejects a revoked qualification from the canonical readback", async () => {
    const models = { readResearchProjectModelConfiguration: vi.fn().mockResolvedValue({ ...configuration,
      selected: { ...selected, qualification_state: "qualification_required" } }), selectResearchProjectModelConfiguration: vi.fn() };
    const runs = createResearchRunsApi({ epoch: createSessionEpoch(), errors: error => new Error(error.code),
      request: async () => { throw new Error("No run dispatch"); } });
    await expect(prepareChatModelRunV4({ models: models as never, runs, projectId: configuration.project_id,
      generation: "deployment-1", candidate: selected, modelChoice: { provider_id: provider, model_id: model },
      signal: new AbortController().signal, isCurrent: () => true, mintSelectionOperation: () => "unused",
      request: { query: "Read selected sources", scope_expression: { kind: "PROJECT", project_id: configuration.project_id } } })).rejects.toThrow();
  });
});
