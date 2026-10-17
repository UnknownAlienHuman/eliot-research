import { describe, expect, it, vi } from "vitest";
import type { ResearchModelConfigurationRevision, ResearchProjectModelConfiguration } from "@eliotr/owner-api-client";
import { ChatModelQualificationRequiredError, ChatModelSelectionUnconfirmedError, prepareBuiltinChatModelRunV4,
  prepareChatModelRunV5 } from "./chatModelSelection";
import { readWorkersAiCatalogFixture } from "./workersAiCatalog.test-fixture";

const projectId = "project-chat";
const sha = "a".repeat(64);
const modelChoice = { provider_id: "openai", model_id: "glm-5.3-flash" } as const;
const modelSelection: ResearchModelConfigurationRevision["model_selections"][number] = {
  stage: "SYNTHESIZE", route_ref: "route/research", route_version: "v1", candidate_ref: "candidate-1",
  candidate_sha256: "e".repeat(64), qualification_ref: "qualification-1", qualification_sha256: "f".repeat(64),
  provider_id: modelChoice.provider_id, model_id: modelChoice.model_id, effective_reasoning_effort: "max",
  transport_policy: { version: 1, transport: "cloudflare-ai-gateway", api: "compat-chat-completions", provider: "openai",
    model: modelChoice.model_id, billing: { mode: "byok", alias: "default" },
    capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["max", "high", "low"] } },
};
const candidate: ResearchModelConfigurationRevision = {
  configuration_ref: `rpmc-${sha}`, configuration_sha256: sha, created_at: "2026-10-16T12:00:00.000Z",
  qualification_state: "qualified", semantic_revision: { revision_ref: "semantic-1", config_sha256: "b".repeat(64) },
  model_selections: [modelSelection],
};
const another: ResearchModelConfigurationRevision = { ...candidate,
  configuration_ref: `rpmc-${"c".repeat(64)}`, configuration_sha256: "c".repeat(64) };
const configuration = (selectionRevision: number, selected: ResearchModelConfigurationRevision | null): ResearchProjectModelConfiguration => ({
  protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId, selection_revision: selectionRevision,
  selected, revisions: [candidate, another], next_cursor: null,
});
const request = { query: "Compare the selected sources", scope_expression: { kind: "PROJECT" as const, project_id: projectId },
  output_language: "ru" as const, max_results: 8 };

describe("chat model selection and v5 method pin", () => {
  it("builds a builtin v4 selection from a canonical Workers AI catalog model", async () => {
    const { catalog } = await readWorkersAiCatalogFixture();
    const choice = catalog.models[0];
    if (!choice) throw new Error("Workers AI fixture must contain its default model");
    const runs = { researchRunBodyV4: vi.fn().mockReturnValue("builtin-v4-body") };
    const request = { query: "Compare the selected sources", scope_expression: { kind: "PROJECT" as const, project_id: projectId },
      output_language: "en" as const };
    const result = prepareBuiltinChatModelRunV4({ runs: runs as never, request, modelChoice: choice,
      bindingAvailable: true, defaultModelId: choice.model_id, signal: new AbortController().signal,
      isCurrent: () => true });
    expect(result).toEqual({ body: "builtin-v4-body", selection: { kind: "builtin", expected_model_id: choice.model_id } });
    expect(runs.researchRunBodyV4).toHaveBeenCalledExactlyOnceWith({ ...request,
      selection: { kind: "builtin", expected_model_id: choice.model_id } });
  });

  it.each([
    { provider_id: "cloudflare-workers-ai", model_id: "@cf/old-default", bindingAvailable: true },
    { provider_id: "workers-ai", model_id: "@cf/current-default", bindingAvailable: true },
    { provider_id: "openai", model_id: "@cf/current-default", bindingAvailable: true },
    { provider_id: "cloudflare-workers-ai", model_id: "@cf/current-default", bindingAvailable: false },
  ])("refuses a stale, noncanonical or unavailable builtin model: %j", ({ provider_id, model_id, bindingAvailable }) => {
    const runs = { researchRunBodyV4: vi.fn() };
    const request = { query: "q", scope_expression: { kind: "PROJECT" as const, project_id: projectId } };
    expect(() => prepareBuiltinChatModelRunV4({ runs: runs as never, request,
      modelChoice: { provider_id, model_id }, bindingAvailable,
      defaultModelId: "@cf/current-default", signal: new AbortController().signal, isCurrent: () => true }))
      .toThrow(ChatModelSelectionUnconfirmedError);
    expect(runs.researchRunBodyV4).not.toHaveBeenCalled();
  });

  it("pins the exact already-selected qualified configuration without mutating it", async () => {
    const models = { readResearchProjectModelConfiguration: vi.fn().mockResolvedValue(configuration(4, candidate)),
      selectResearchProjectModelConfiguration: vi.fn() };
    const runs = { researchRunBodyV5: vi.fn().mockReturnValue("exact-v5-body") };
    const result = await prepareChatModelRunV5({ models: models as never, runs: runs as never, projectId,
      generation: "deployment-1", candidate, modelChoice, request, method: "evidence_review", signal: new AbortController().signal,
      isCurrent: () => true, mintSelectionOperation: () => "unused-selection-op" });
    expect(result).toEqual({ body: "exact-v5-body", selection: {
      configuration_project_id: projectId, configuration_ref: candidate.configuration_ref,
      configuration_sha256: sha, selection_revision: 4,
    } });
    expect(models.selectResearchProjectModelConfiguration).not.toHaveBeenCalled();
    expect(runs.researchRunBodyV5).toHaveBeenCalledExactlyOnceWith({ ...request, method: "evidence_review", selection: result.selection });
  });

  it("selects one qualified candidate, reads it back, then builds v4 from the receipt-matched revision", async () => {
    const models = { readResearchProjectModelConfiguration: vi.fn()
      .mockResolvedValueOnce(configuration(3, another)).mockResolvedValueOnce(configuration(4, candidate)),
      selectResearchProjectModelConfiguration: vi.fn().mockResolvedValue({
        protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId,
        selection_revision: 4, selected: candidate,
      }) };
    const runs = { researchRunBodyV5: vi.fn().mockReturnValue("exact-v5-body") };
    const result = await prepareChatModelRunV5({ models: models as never, runs: runs as never, projectId,
      generation: "deployment-1", candidate, modelChoice, request, signal: new AbortController().signal,
      isCurrent: () => true, mintSelectionOperation: () => "selection-operation-1" });
    expect(models.selectResearchProjectModelConfiguration).toHaveBeenCalledExactlyOnceWith(
      projectId, "deployment-1", 3, candidate.configuration_ref, "selection-operation-1", expect.any(AbortSignal));
    expect(result.selection.selection_revision).toBe(4);
    expect(runs.researchRunBodyV5).toHaveBeenCalledExactlyOnceWith({ ...request, method: "lookup", selection: result.selection });
  });

  it("does not build or submit a run when the selected configuration readback differs", async () => {
    const models = { readResearchProjectModelConfiguration: vi.fn()
      .mockResolvedValueOnce(configuration(3, another)).mockResolvedValueOnce(configuration(4, another)),
      selectResearchProjectModelConfiguration: vi.fn().mockRejectedValue(new Error("selection acknowledgement unknown")) };
    const runs = { researchRunBodyV5: vi.fn() };
    await expect(prepareChatModelRunV5({ models: models as never, runs: runs as never, projectId,
      generation: "deployment-1", candidate, modelChoice, request, signal: new AbortController().signal,
      isCurrent: () => true, mintSelectionOperation: () => "selection-operation-1" }))
      .rejects.toBeInstanceOf(ChatModelSelectionUnconfirmedError);
    expect(models.selectResearchProjectModelConfiguration).toHaveBeenCalledTimes(1);
    expect(runs.researchRunBodyV5).not.toHaveBeenCalled();
  });

  it("qualifies only the selected unqualified configuration through model-use, then pins its exact readback", async () => {
    const unqualified = { ...candidate, qualification_state: "qualification_required" as const };
    const qualifiedAfterUse: ResearchModelConfigurationRevision = { ...candidate,
      configuration_ref: `rpmc-${"d".repeat(64)}`, configuration_sha256: "d".repeat(64) };
    const models = { readResearchProjectModelConfiguration: vi.fn()
      .mockResolvedValueOnce(configuration(3, null)).mockResolvedValueOnce(configuration(4, unqualified))
      .mockResolvedValueOnce(configuration(5, qualifiedAfterUse)),
      selectResearchProjectModelConfiguration: vi.fn().mockResolvedValue({
        protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId,
        selection_revision: 4, selected: unqualified,
      }) };
    const modelUse = { startResearchProviderKeyModelUse: vi.fn().mockResolvedValue({
      state: "selected", selected_configuration_ref: qualifiedAfterUse.configuration_ref, selection_revision: 5,
    }) };
    const runs = { researchRunBodyV5: vi.fn().mockReturnValue("exact-v5-body") };
    const result = await prepareChatModelRunV5({ models: models as never, runs: runs as never, projectId,
      generation: "deployment-1", candidate: unqualified, modelChoice, request, signal: new AbortController().signal,
      isCurrent: () => true, mintSelectionOperation: () => "selection-operation-1",
      modelUse: { api: modelUse as never, keyOperationId: "provider-key-operation-1",
        mintOperationId: () => "model-use-operation-1" } });
    expect(modelUse.startResearchProviderKeyModelUse).toHaveBeenCalledExactlyOnceWith(projectId, "deployment-1",
      "provider-key-operation-1", "model-use-operation-1", 4, expect.any(AbortSignal));
    expect(result.selection).toEqual({ configuration_project_id: projectId,
      configuration_ref: qualifiedAfterUse.configuration_ref, configuration_sha256: qualifiedAfterUse.configuration_sha256,
      selection_revision: 5 });
    expect(runs.researchRunBodyV5).toHaveBeenCalledExactlyOnceWith({ ...request, method: "lookup", selection: result.selection });
  });

  it("reconciles a lost model-use acknowledgement by reading the same operation without reposting", async () => {
    const unqualified = { ...candidate, qualification_state: "qualification_required" as const };
    const qualifiedAfterUse: ResearchModelConfigurationRevision = { ...candidate,
      configuration_ref: `rpmc-${"d".repeat(64)}`, configuration_sha256: "d".repeat(64) };
    const models = { readResearchProjectModelConfiguration: vi.fn()
      .mockResolvedValueOnce(configuration(3, null)).mockResolvedValueOnce(configuration(4, unqualified))
      .mockResolvedValueOnce(configuration(5, qualifiedAfterUse)),
      selectResearchProjectModelConfiguration: vi.fn().mockResolvedValue({
        protocol: "eliotr.research-project-model-configuration.v1", project_id: projectId,
        selection_revision: 4, selected: unqualified,
      }) };
    const operation = { protocol: "eliotr.research.provider-key-model-use.v1", project_id: projectId,
      operation_id: "model-use-operation-1", key_operation_id: "provider-key-operation-1", state: "selected",
      phase: "complete", selected_configuration_ref: qualifiedAfterUse.configuration_ref,
      selection_revision: 5, failure_code: null, created_at: "2026-10-16T12:00:00.000Z",
      updated_at: "2026-10-16T12:01:00.000Z" };
    const modelUse = { startResearchProviderKeyModelUse: vi.fn().mockRejectedValue(new Error("lost acknowledgement")),
      readResearchProviderKeyModelUse: vi.fn().mockResolvedValue(operation) };
    const runs = { researchRunBodyV5: vi.fn().mockReturnValue("exact-v5-body") };
    const result = await prepareChatModelRunV5({ models: models as never, runs: runs as never, projectId,
      generation: "deployment-1", candidate: unqualified, modelChoice, request, signal: new AbortController().signal,
      isCurrent: () => true, mintSelectionOperation: () => "selection-operation-1",
      modelUse: { api: modelUse as never, keyOperationId: "provider-key-operation-1",
        mintOperationId: () => "model-use-operation-1" } });
    expect(modelUse.startResearchProviderKeyModelUse).toHaveBeenCalledTimes(1);
    expect(modelUse.readResearchProviderKeyModelUse).toHaveBeenCalledExactlyOnceWith(projectId, "deployment-1",
      "provider-key-operation-1", "model-use-operation-1", expect.any(AbortSignal));
    expect(result.selection.selection_revision).toBe(5);
    expect(runs.researchRunBodyV5).toHaveBeenCalledExactlyOnceWith({ ...request, method: "lookup", selection: result.selection });
  });

  it("refuses an unqualified candidate before any selection mutation", async () => {
    const models = { readResearchProjectModelConfiguration: vi.fn(), selectResearchProjectModelConfiguration: vi.fn() };
    const runs = { researchRunBodyV5: vi.fn() };
    await expect(prepareChatModelRunV5({ models: models as never, runs: runs as never, projectId,
      generation: "deployment-1", candidate: { ...candidate, qualification_state: "qualification_required" }, modelChoice, request,
      signal: new AbortController().signal, isCurrent: () => true, mintSelectionOperation: () => "selection-operation-1" }))
      .rejects.toBeInstanceOf(ChatModelQualificationRequiredError);
    expect(models.readResearchProjectModelConfiguration).not.toHaveBeenCalled();
    expect(models.selectResearchProjectModelConfiguration).not.toHaveBeenCalled();
  });
});
