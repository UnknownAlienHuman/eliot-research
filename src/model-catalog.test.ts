import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverGatewayModels } from "./model-catalog";
import { DEFAULT_MODEL, MODELS, getModelProviders, modelProviderSchema, modelOutputLimit, providerForRoute, readModelCatalog, refreshModelCatalog, requireAvailableModel, requireCatalogModel, saveModelDefaults, saveModelProviders } from "./models";
import type { ModelProvider } from "./models";
import { nativeModel } from "./native-model-catalog";
import { resolveModelTransport } from "./model-transport";
import type { ModelSpec } from "./models";
import { generateText, streamText } from "ai";

const CC = "https://api.commandcode.ai/provider/v1/models";
const OR = "https://openrouter.ai/api/v1/models";
const textChat = { input_modalities: ["text"], output_modalities: ["text"] };

function defaultProviders(): ModelProvider[] {
  return [
    { id: "workers-ai", type: "workers-ai", gatewaySlug: null, gatewayPath: "", baseUrl: null, enabled: true },
    { id: "openrouter", type: "openai-compatible", gatewaySlug: "openrouter", gatewayPath: "v1", baseUrl: "https://openrouter.ai/api/v1", dataCollection: "deny", enabled: true },
    { id: "command-code", type: "openai-compatible", gatewaySlug: "custom-command-code", gatewayPath: "v1", baseUrl: "https://api.commandcode.ai/provider/v1", enabled: true },
  ];
}

function catalogues(cc: unknown[], or: unknown[]) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url !== CC && url !== OR) throw new Error("Unexpected metadata endpoint");
    return Response.json({ data: url === CC ? cc : or });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function fakeBucket(initial: unknown | null = null) {
  let stored = initial;
  const get = vi.fn(async (key: string) => {
    if (key !== "catalog/models.json" || stored === null) return null;
    const json = JSON.stringify(stored);
    return { size: new TextEncoder().encode(json).byteLength, json: async () => JSON.parse(json) };
  });
  const put = vi.fn(async (key: string, value: unknown) => {
    if (key === "catalog/models.json") stored = JSON.parse(String(value));
    return {};
  });
  return { binding: { get, put } as unknown as R2Bucket, get, put, stored: () => stored };
}

function fixtureEnv(bucket: R2Bucket, opts: { providers?: ModelProvider[]; providersRaw?: string; gatewayId?: string | null; aiModels?: () => Promise<never[]>;
  settings?: { answerModel: string; distillModel: string; updatedAt: number } } = {}): Env {
  let providersJson = opts.providersRaw !== undefined ? opts.providersRaw : JSON.stringify(opts.providers !== undefined ? opts.providers : defaultProviders());
  const gatewayId = opts.gatewayId === undefined ? "fixture-gateway" : opts.gatewayId;
  const aiModels = opts.aiModels !== undefined ? opts.aiModels : async () => [];
  const settings = { answerModel: DEFAULT_MODEL, distillModel: DEFAULT_MODEL, updatedAt: 0, ...opts.settings };
  return {
    DB: {
      prepare: (sql: string) => ({
        first: async () => {
          if (sql.indexOf("model_providers_json") >= 0) return { providers: providersJson };
          if (sql.indexOf("model_gateway_id") >= 0) return { gatewayId: gatewayId };
          if (sql.startsWith("SELECT answer_model")) return { ...settings };
          return null;
        },
        bind: (...values: unknown[]) => ({ run: async () => {
          if (sql.startsWith("UPDATE settings SET model_providers_json=")) providersJson = String(values[0]);
          else if (sql.startsWith("UPDATE settings SET answer_model=COALESCE(")) {
            if (values[0] !== null) settings.answerModel = String(values[0]);
            if (values[1] !== null) settings.distillModel = String(values[1]);
            settings.updatedAt = Number(values[2]);
          } else throw new Error("Unexpected fixture write");
          return { meta: { changes: 1 } };
        } }),
      }),
    } as unknown as Env["DB"],
    BUCKET: bucket,
    AI: { models: aiModels } as unknown as Env["AI"],
  } as unknown as Env;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("provider model catalogue discovery", () => {
  it.each(["answerModel", "distillModel"] as const)("updates only %s while retaining an untouched unavailable default and accepts an unchanged stale replay", async field => {
    const disabledRoute = "gateway:command-code/disabled-model";
    const original = { answerModel: "gateway:retired/answer", distillModel: field === "answerModel" ? disabledRoute : "gateway:retired/understanding", updatedAt: 7 };
    const providers = defaultProviders().map(provider => ({ ...provider, enabled: provider.id !== "command-code" }));
    const bucket = fakeBucket({ updatedAt: "2026-11-07T00:00:00.000Z", warnings: [], providers, models: [...MODELS,
      { route: disabledRoute, id: "disabled-model", label: "Disabled model", contextTokens: null, maxOutputTokens: null, enabled: true, checkedOn: "2026-11-07" }] });
    const env = fixtureEnv(bucket.binding, { providers, settings: original, gatewayId: null });
    const network = vi.fn(async () => { throw new Error("Defaults Save must not discover or infer"); }); vi.stubGlobal("fetch", network);
    const clock = vi.spyOn(Date, "now").mockReturnValue(10);
    try {
      const saved = await saveModelDefaults(env, { [field]: DEFAULT_MODEL });
      expect(saved).toEqual({ ...original, [field]: DEFAULT_MODEL, updatedAt: 10 });
      clock.mockReturnValue(20);
      await expect(saveModelDefaults(env, { answerModel: saved?.answerModel, distillModel: saved?.distillModel })).resolves.toEqual(saved);
      await expect(saveModelDefaults(env, {})).rejects.toThrow();
      const reads = bucket.get.mock.calls.length;
      await expect(saveModelDefaults(env, { nativeUsageMode: "included", [field]: DEFAULT_MODEL })).rejects.toMatchObject({ code: "invalid", status: 400 });
      expect(bucket.get.mock.calls).toHaveLength(reads); expect(bucket.put).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("does not resurrect Flash from an authoritative native catalogue, including after a failed native refresh", async () => {
    const other = { route: "workers-ai:@cf/vendor/other", id: "@cf/vendor/other", label: "Other native", enabled: true,
      contextTokens: 64000, maxOutputTokens: null, outputReserveTokens: 8192, checkedOn: "2026-11-07" };
    const providers = defaultProviders().filter(provider => provider.type === "workers-ai");
    const bucket = fakeBucket();
    const aiModels = vi.fn(async () => [{ name: other.id, task: { name: "Text Generation" },
      properties: [{ property_id: "context_window", value: "64000" }] }] as never[]);
    const env = fixtureEnv(bucket.binding, { providers, gatewayId: null, aiModels });
    const read = await refreshModelCatalog(env);
    expect(read.models.map(model => model.route)).toEqual([other.route]);
    await expect(requireCatalogModel(env, DEFAULT_MODEL)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    await expect(requireAvailableModel(env, DEFAULT_MODEL)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(aiModels).toHaveBeenCalledTimes(1);
    aiModels.mockRejectedValueOnce(new Error("Private native discovery failure"));
    const refreshed = await refreshModelCatalog(env);
    expect(refreshed.models).toEqual(read.models);
    expect(refreshed.warnings).toContain("Workers AI model catalogue is unavailable.");
    expect(JSON.stringify(bucket.stored())).not.toContain("Private native discovery failure");
    await expect(requireAvailableModel(env, DEFAULT_MODEL)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(aiModels).toHaveBeenCalledTimes(2);
  });

  it("allows configured catalogue selection without Gateway consent while preserving execution and metadata guards", async () => {
    const models = ["openrouter", "command-code"].map(provider => ({ route: "gateway:" + provider + "/shared-model", id: "shared-model", label: "Shared model",
      contextTokens: null, maxOutputTokens: null, enabled: true, checkedOn: "2026-11-07" }));
    const providers = defaultProviders();
    const bucket = fakeBucket({ updatedAt: "2026-11-07T00:00:00.000Z", warnings: [], models, providers });
    const before = JSON.stringify(bucket.stored()), aiModels = vi.fn(async () => [] as never[]);
    const env = fixtureEnv(bucket.binding, { gatewayId: null, aiModels });
    const network = vi.fn(async () => { throw new Error("Selection must not refresh or start a model request"); });
    vi.stubGlobal("fetch", network);
    const catalog = await readModelCatalog(env);
    const external = catalog.models.filter(model => model.route.startsWith("gateway:"));
    expect(external.map(model => model.route)).toEqual(models.map(model => model.route));
    for (const row of models) {
      await expect(requireCatalogModel(env, row.route)).resolves.toMatchObject({ route: row.route, selectable: true,
        enabled: false, contextTokens: null, unavailableReason: "Connect AI Gateway in Settings." });
      await expect(requireAvailableModel(env, row.route)).rejects.toThrow("Connect AI Gateway in Settings.");
    }
    const connected = fixtureEnv(bucket.binding);
    await expect(requireCatalogModel(connected, "gateway:openrouter/shared-model")).resolves.toMatchObject({ selectable: true, enabled: true, contextTokens: null });
    await expect(requireAvailableModel(connected, "gateway:openrouter/shared-model")).rejects.toThrow("The provider has not published usable context/output metadata.");
    const disabled = fixtureEnv(bucket.binding, { providers: providers.map(provider => ({ ...provider, enabled: provider.id === "workers-ai" })) });
    await expect(requireCatalogModel(disabled, "gateway:openrouter/shared-model")).rejects.toThrow("Provider is disabled.");
    expect(JSON.stringify(bucket.stored())).toBe(before); expect(bucket.put).not.toHaveBeenCalled();
    expect(aiModels).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });

  it("does not infer a combined window when reading an old cached input ceiling", async () => {
    const old = { route: "gateway:command-code/hy3", id: "hy3", label: "Legacy metadata",
      contextTokens: 192000, maxOutputTokens: 128000, outputReserveTokens: 8192, enabled: true, checkedOn: "2026-11-03" };
    const bucket = fakeBucket({ updatedAt: "2026-11-03T00:00:00.000Z", warnings: [], models: [old], providers: defaultProviders() });
    const before = JSON.stringify(bucket.stored());
    const network = vi.fn(async () => { throw new Error("Unexpected metadata refresh"); });
    vi.stubGlobal("fetch", network);
    const model = await requireAvailableModel(fixtureEnv(bucket.binding), old.route);
    expect(model).not.toHaveProperty("contextWindowTokens");
    expect(modelOutputLimit(model, 100000)).toBe(128000);
    expect(JSON.stringify(bucket.stored())).toBe(before);
    expect(bucket.put).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("does not infer a combined window after generic provider refresh with context_length only", async () => {
    const row = { id: "hy3", context_length: 192000, max_output_tokens: 128000, supported_endpoints: ["/chat/completions"] };
    const fetcher = catalogues([row], []);
    const bucket = fakeBucket();
    const result = await refreshModelCatalog(fixtureEnv(bucket.binding));
    const model = result.models.find((entry) => entry.route === "gateway:command-code/hy3");
    if (!model) throw new Error("The generic provider model is missing.");
    expect(model).not.toHaveProperty("contextWindowTokens");
    expect(modelOutputLimit(model, 100000)).toBe(128000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("lists arbitrary new native IDs without a model allowlist and preserves unknown metadata", async () => {
    const id = "unlisted-vendor/new-model:preview";
    const fetcher = catalogues([{ id: id, name: "New public model", context_length: 256000, supported_endpoints: ["/chat/completions"] }], []);
    const warnings: string[] = [];
    const seen: string[] = [];
    const models = await discoverGatewayModels(defaultProviders(), (pid, message) => { seen.push(pid); warnings.push(message); });
    expect(models).toEqual([expect.objectContaining({ id: id, label: "New public model", contextTokens: 256000, maxOutputTokens: null, outputReserveTokens: 8192, checkedOn: expect.any(String), enabled: true })]);
    expect(models[0]).not.toHaveProperty("inputMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("cachedMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("outputMicrousdPerMillion");
    expect(warnings).toEqual([]);
    expect(seen).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) expect(call).toHaveLength(2);
  });

  it("reports text capabilities with context/output and no currency fields", async () => {
    const id = "new-provider/model-v123";
    catalogues([], [{ id: id, context_length: 100000, architecture: textChat, top_provider: { max_completion_tokens: 20000 }, supported_parameters: ["response_format", "structured_outputs"], pricing: { prompt: "0.000001", completion: 0.000002 } }]);
    const models = await discoverGatewayModels(defaultProviders());
    expect(models).toEqual([expect.objectContaining({ route: "gateway:openrouter/" + id, id: id, contextTokens: 100000, maxOutputTokens: 20000, outputReserveTokens: 8192, enabled: true, responseFormat: true, structuredOutputs: true })]);
    expect(models[0]).not.toHaveProperty("inputMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("cachedMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("outputMicrousdPerMillion");
  });

  it("preserves advertised image support and missing input capabilities from OpenRouter", async () => {
    catalogues([], [
      { id: "fixture/one", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "fixture/two", architecture: textChat },
      { id: "fixture/three", architecture: { output_modalities: ["text"] } },
    ]);
    const models = await discoverGatewayModels(defaultProviders());
    expect(models.map((model) => model.supportsImages)).toEqual([true, false, undefined]);
    expect(models[2]).not.toHaveProperty("supportsImages");
    expect(models.every((model) => model.enabled)).toBe(true);
  });

  it("recognizes only explicit Kilo toggle/OFF metadata on the official API root", async () => {
    const instant = { reasoning: { enabled: false, effort: "none" } };
    const opencode = { variants: { instant, thinking: { reasoning: { enabled: true, effort: "high" } } }, reasoning_options: [{ type: "toggle" }] };
    const row = { context_length: 1048576, top_provider: { max_completion_tokens: 943718 }, architecture: textChat,
      supported_parameters: ["reasoning", "response_format", "structured_outputs"], opencode };
    const rows = [
      { ...row, id: "opaque-positive" },
      { ...row, id: "params-only", opencode: undefined },
      { ...row, id: "off-only", opencode: { variants: opencode.variants } },
      { ...row, id: "toggle-only", opencode: { reasoning_options: opencode.reasoning_options } },
      { ...row, id: "no-parameter", supported_parameters: [] },
      { ...row, id: "malformed-toggle", opencode: { ...opencode, reasoning_options: ["toggle"] } },
      { ...row, id: "mixed-toggle", opencode: { ...opencode, reasoning_options: [{ type: "toggle" }, null] } },
      { ...row, id: "string-enabled", opencode: { ...opencode, variants: { instant: { reasoning: { enabled: "false", effort: "none" } } } } },
      { ...row, id: "no-effort", opencode: { ...opencode, variants: { instant: { reasoning: { enabled: false } } } } },
      { ...row, id: "other-effort", opencode: { ...opencode, variants: { instant: { reasoning: { enabled: false, effort: "minimal" } } } } },
      { ...row, id: "extra-off-field", opencode: { ...opencode, variants: { instant: { reasoning: { enabled: false, effort: "none", max_tokens: 1 } } } } },
      { ...row, id: "mandatory", reasoning: { mandatory: true } },
      { ...row, id: "malformed-mandatory", reasoning: { mandatory: "false" } },
      { ...row, id: "malformed-reasoning", reasoning: "unknown" },
      { ...row, id: "unverified-optional", opencode: undefined, reasoning: { mandatory: false } },
    ];
    const provider: ModelProvider = { id: "fixture", type: "openai-compatible", baseUrl: "https://ai-gateway.kilo.ai/api/v1",
      gatewaySlug: null, gatewayPath: "", authMode: "anonymous", enabled: true };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: rows })));
    const models = await discoverGatewayModels([provider]);
    expect(models).toHaveLength(rows.length);
    expect(models[0]).toMatchObject({ optionalReasoning: true, structuredReasoningEffort: "none", contextTokens: 1048576, maxOutputTokens: 943718 });
    for (const field of ["contextWindowTokens", "openRouterReasoningEfforts"]) expect(models[0]).not.toHaveProperty(field);
    for (const model of models.slice(1)) expect(model).not.toHaveProperty("optionalReasoning");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ ...row, id: "renamed", opencode: {
      ...opencode, variants: { anyPublishedName: instant } } }] })));
    expect((await discoverGatewayModels([provider]))[0]).toMatchObject({ optionalReasoning: true, structuredReasoningEffort: "none" });
    for (const baseUrl of ["https://api.commandcode.ai/provider/v1", "https://ai-gateway.kilo.ai/api/v1/other", "https://ai-gateway.kilo.ai.example.com/api/v1"]) {
      const [model] = await discoverGatewayModels([{ ...provider, baseUrl }]);
      expect(model).toBeDefined(); expect(model).not.toHaveProperty("optionalReasoning"); expect(model).not.toHaveProperty("structuredReasoningEffort");
    }
  });

  it("keeps ordinary custom-catalogue metadata without authorizing Kilo OFF on an official provider base", async () => {
    const modelsUrl = "https://catalogue.example.com/models";
    const provider: ModelProvider = { id: "fixture", type: "openai-compatible", baseUrl: "https://ai-gateway.kilo.ai/api/v1", modelsUrl,
      gatewaySlug: null, gatewayPath: "", authMode: "anonymous", enabled: true };
    const network = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(modelsUrl);
      return Response.json({ data: [{ id: "opaque", context_length: 1048576, top_provider: { max_completion_tokens: 943718 },
        supported_parameters: ["reasoning", "response_format", "structured_outputs"],
        opencode: { variants: { instant: { reasoning: { enabled: false, effort: "none" } } }, reasoning_options: [{ type: "toggle" }] } }] });
    });
    vi.stubGlobal("fetch", network);
    const [model] = await discoverGatewayModels([provider]);
    expect(model).toMatchObject({ id: "opaque", contextTokens: 1048576, maxOutputTokens: 943718, responseFormat: true, structuredOutputs: true, enabled: true });
    expect(model).not.toHaveProperty("optionalReasoning"); expect(model).not.toHaveProperty("structuredReasoningEffort");
    expect(network).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, true])("discovers Kilo OFF only on refresh, preserving an old optional=%s snapshot without enrichment", async optionalReasoning => {
    const provider: ModelProvider = { id: "fixture", type: "openai-compatible", baseUrl: "https://ai-gateway.kilo.ai/api/v1",
      gatewaySlug: null, gatewayPath: "", authMode: "anonymous", enabled: true };
    const model = { route: "gateway:fixture/opaque", id: "opaque", label: "Opaque", contextTokens: 1048576, maxOutputTokens: 943718,
      outputReserveTokens: 8192, ...(optionalReasoning === undefined ? {} : { optionalReasoning }), checkedOn: "2026-11-08", enabled: true };
    const bucket = fakeBucket({ updatedAt: "2026-11-08T00:00:00.000Z", warnings: [], providers: [provider], models: [model] });
    const env = fixtureEnv(bucket.binding, { providers: [provider], gatewayId: null });
    const network = vi.fn(async () => Response.json({ data: [{ id: model.id, context_length: model.contextTokens,
      top_provider: { max_completion_tokens: model.maxOutputTokens }, supported_parameters: ["reasoning"],
      opencode: { variants: { instant: { reasoning: { enabled: false, effort: "none" } } }, reasoning_options: [{ type: "toggle" }] } }] }));
    vi.stubGlobal("fetch", network);
    expect((await readModelCatalog(env)).models[0]?.optionalReasoning).toBe(optionalReasoning);
    expect(await requireAvailableModel(env, model.route)).not.toHaveProperty("structuredReasoningEffort");
    expect(network).not.toHaveBeenCalled();
    await refreshModelCatalog(env);
    expect(network).toHaveBeenCalledTimes(1);
    const admitted = await requireAvailableModel(env, model.route);
    expect(admitted).toMatchObject({ optionalReasoning: true, structuredReasoningEffort: "none", routing: { gatewayId: null, provider } });
    const stored = bucket.stored() as { models: { optionalReasoning?: boolean; structuredReasoningEffort?: string }[] };
    expect(stored.models[0]?.structuredReasoningEffort).toBe("none");
    delete stored.models[0]?.structuredReasoningEffort;
    expect((await readModelCatalog(env)).models[0]).not.toHaveProperty("structuredReasoningEffort");
    expect(admitted.structuredReasoningEffort).toBe("none");
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("derives mandatory minimal structured reasoning only from the exact published profile", async () => {
    catalogues([], [
      { id: "provider/crouton-like", context_length: 100000, architecture: textChat,
        supported_parameters: ["reasoning", "reasoning_effort", "response_format", "structured_outputs"],
        reasoning: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low", "minimal"], default_effort: "max" } },
      { id: "provider/mandatory-false", context_length: 100000, architecture: textChat,
        supported_parameters: ["reasoning"], reasoning: { mandatory: false, supported_efforts: ["max", "minimal"] } },
      { id: "provider/missing-efforts", context_length: 100000, architecture: textChat,
        supported_parameters: ["reasoning"], reasoning: { mandatory: true } },
      { id: "provider/malformed-efforts", context_length: 100000, architecture: textChat,
        supported_parameters: ["reasoning"], reasoning: { mandatory: true, supported_efforts: ["minimal", "minimal", 7] } },
      { id: "provider/shorthand-only", context_length: 100000, architecture: textChat,
        supported_parameters: ["reasoning_effort"], reasoning: { mandatory: true, supported_efforts: ["minimal"] } },
      { id: "provider/no-minimal", context_length: 100000, architecture: textChat,
        supported_parameters: ["reasoning"], reasoning: { mandatory: true, supported_efforts: ["max", "high"] } },
    ]);
    const models = await discoverGatewayModels(defaultProviders());
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("provider/crouton-like")).toMatchObject({ structuredReasoningEffort: "minimal", structuredOutputs: true, enabled: true });
    expect(byId.get("provider/crouton-like")?.openRouterReasoningEfforts).toEqual(["max", "xhigh", "high", "medium", "low", "minimal"]);
    expect(byId.get("provider/crouton-like")).not.toHaveProperty("optionalReasoning");
    expect(byId.get("provider/mandatory-false")).toMatchObject({ optionalReasoning: true });
    expect(byId.get("provider/mandatory-false")?.openRouterReasoningEfforts).toEqual(["max", "minimal"]);
    expect(byId.get("provider/mandatory-false")).not.toHaveProperty("structuredReasoningEffort");
    for (const id of ["provider/missing-efforts", "provider/malformed-efforts", "provider/shorthand-only", "provider/no-minimal"]) {
      expect(byId.get(id)).not.toHaveProperty("structuredReasoningEffort");
      expect(byId.get(id)).not.toHaveProperty("optionalReasoning");
    }
    expect(byId.get("provider/no-minimal")?.openRouterReasoningEfforts).toEqual(["max", "high"]);
    for (const id of ["provider/missing-efforts", "provider/malformed-efforts", "provider/shorthand-only"])
      expect(byId.get(id)).not.toHaveProperty("openRouterReasoningEfforts");
  });

  it("publishes whole bounded reasoning lists only for the official configured API root", async () => {
    const row = { id: "provider/new-efforts", context_length: 100000, architecture: textChat,
      supported_parameters: ["reasoning"], reasoning: { mandatory: true, supported_efforts: ["minimal", "high"] } };
    const malformed = [
      {}, { mandatory: "true", supported_efforts: ["high"] },
      { mandatory: true, supported_efforts: [] }, { mandatory: true, supported_efforts: ["high", "high"] },
      { mandatory: true, supported_efforts: ["high", 1] },
      { mandatory: true, supported_efforts: ["high", "none"] }, { mandatory: true, supported_efforts: ["high", "off"] },
      { mandatory: true, supported_efforts: Array.from({ length: 17 }, (_, i) => "effort_" + i) },
      { mandatory: true, supported_efforts: ["high", "x".repeat(33)] },
      { mandatory: true, supported_efforts: ["high", "высокий"] },
      { mandatory: true, supported_efforts: ["high", "High"] },
      { mandatory: true, supported_efforts: ["high", "1high"] },
      { mandatory: true, supported_efforts: ["high", "low\n"] },
    ];
    const boundary = ["x".repeat(32), ...Array.from({ length: 15 }, (_, i) => "effort_" + i)];
    catalogues([row], [row,
      ...malformed.map((reasoning, i) => ({ ...row, id: "invalid/" + i, reasoning })),
      { ...row, id: "provider/parse-boundary", reasoning: { mandatory: false, supported_efforts: boundary } },
      { ...row, id: "provider/optional-off", reasoning: { mandatory: false, supported_efforts: ["none", "off", "high"] } },
      { ...row, id: "provider/unadvertised", supported_parameters: ["reasoning_effort"] },
      { ...row, id: "provider/no-mandatory", reasoning: { supported_efforts: ["high"] } },
    ]);
    const models = await discoverGatewayModels(defaultProviders());
    expect(models.find(model => model.route === "gateway:openrouter/" + row.id)?.openRouterReasoningEfforts).toEqual(["minimal", "high"]);
    expect(models.find(model => model.route === "gateway:command-code/" + row.id)).not.toHaveProperty("openRouterReasoningEfforts");
    expect(models.find(model => model.id === "provider/parse-boundary")?.openRouterReasoningEfforts).toEqual(boundary);
    expect(models.find(model => model.id === "provider/optional-off")?.openRouterReasoningEfforts).toEqual(["none", "off", "high"]);
    for (const model of models.filter(model => model.id.startsWith("invalid/") || ["provider/unadvertised", "provider/no-mandatory"].includes(model.id)))
      expect(model).not.toHaveProperty("openRouterReasoningEfforts");
  });

  it("propagates temperature and optional reasoning only from advertised metadata", async () => {
    catalogues([], [
      { id: "provider/synth-both", context_length: 100000, architecture: textChat, supported_parameters: ["temperature", "reasoning"], reasoning: { mandatory: false } },
      { id: "provider/synth-temp-yes", context_length: 100000, architecture: textChat, supported_parameters: ["temperature"] },
      { id: "provider/synth-temp-no", context_length: 100000, architecture: textChat, supported_parameters: ["response_format"] },
      { id: "provider/synth-temp-missing", context_length: 100000, architecture: textChat },
      { id: "provider/synth-reason-mandatory", context_length: 100000, architecture: textChat, supported_parameters: ["reasoning", "temperature"], reasoning: { mandatory: true } },
      { id: "provider/synth-reason-unknown", context_length: 100000, architecture: textChat, supported_parameters: ["reasoning", "temperature"] },
      { id: "provider/synth-reason-unadvertised", context_length: 100000, architecture: textChat, supported_parameters: ["temperature"], reasoning: { mandatory: false } },
    ]);
    const models = await discoverGatewayModels(defaultProviders());
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("provider/synth-both")).toMatchObject({ supportsTemperature: true, optionalReasoning: true, enabled: true });
    expect(byId.get("provider/synth-temp-yes")).toMatchObject({ supportsTemperature: true, enabled: true });
    expect(byId.get("provider/synth-temp-yes")).not.toHaveProperty("optionalReasoning");
    expect(byId.get("provider/synth-temp-no")).not.toHaveProperty("supportsTemperature");
    expect(byId.get("provider/synth-temp-no")).not.toHaveProperty("optionalReasoning");
    expect(byId.get("provider/synth-temp-missing")).not.toHaveProperty("supportsTemperature");
    expect(byId.get("provider/synth-temp-missing")).not.toHaveProperty("optionalReasoning");
    // Natively mandatory reasoning never disables: temperature may still advertise.
    expect(byId.get("provider/synth-reason-mandatory")).toMatchObject({ supportsTemperature: true, enabled: true });
    expect(byId.get("provider/synth-reason-mandatory")).not.toHaveProperty("optionalReasoning");
    // Missing reasoning metadata means unknown: no inference.
    expect(byId.get("provider/synth-reason-unknown")).toMatchObject({ supportsTemperature: true, enabled: true });
    expect(byId.get("provider/synth-reason-unknown")).not.toHaveProperty("optionalReasoning");
    // mandatory:false without an advertised reasoning parameter means unknown.
    expect(byId.get("provider/synth-reason-unadvertised")).toMatchObject({ supportsTemperature: true, enabled: true });
    expect(byId.get("provider/synth-reason-unadvertised")).not.toHaveProperty("optionalReasoning");
    for (const model of models) {
      expect(model).not.toHaveProperty("inputMicrousdPerMillion");
      expect(model).not.toHaveProperty("cachedMicrousdPerMillion");
      expect(model).not.toHaveProperty("outputMicrousdPerMillion");
    }
  });

  it("ignores tiered pricing overrides and reports only context/output", async () => {
    catalogues([], [{ id: "provider/tiered", context_length: 1000000, architecture: textChat, pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.00000005", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000002", completion: "0.0000075", input_cache_read: "0.0000001" }] } }]);
    const models = await discoverGatewayModels(defaultProviders());
    expect(models).toEqual([expect.objectContaining({ id: "provider/tiered", contextTokens: 1000000, enabled: true, maxOutputTokens: null })]);
    expect(models[0]).not.toHaveProperty("inputMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("cachedMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("outputMicrousdPerMillion");
  });

  it("keeps malformed context selectable but unknown, and paid resolution rejects only that row", async () => {
    const fetcher = catalogues([], [
      { id: "provider/zero", context_length: "100000", architecture: textChat, pricing: { prompt: "0", completion: "0" } },
      { id: "provider/valid-priced", context_length: 100000, architecture: textChat, pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "provider/valid-tiered", context_length: 100000, architecture: textChat, pricing: { prompt: "0.000001", completion: "0.000005", overrides: [{ min_prompt_tokens: 10, prompt: "unknown" }] } },
    ]);
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    const refreshed = await refreshModelCatalog(env);
    const models = refreshed.models.filter((model) => model.route.indexOf("gateway:") === 0);
    expect(models).toHaveLength(3);
    expect(models.every((model) => model.enabled)).toBe(true);
    const first = models[0];
    const second = models[1];
    const third = models[2];
    expect(first?.contextTokens).toBeNull();
    expect(second?.contextTokens).toBe(100000);
    expect(third?.contextTokens).toBe(100000);
    expect(models.every((model) => !("inputMicrousdPerMillion" in model) && !("cachedMicrousdPerMillion" in model) && !("outputMicrousdPerMillion" in model))).toBe(true);
    fetcher.mockClear();
    if (!first || !second || !third) throw new Error("expected three models");
    await expect(requireAvailableModel(env, first.route)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    await expect(requireAvailableModel(env, second.route)).resolves.toMatchObject({ route: second.route });
    await expect(requireAvailableModel(env, third.route)).resolves.toMatchObject({ route: third.route });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("writes explicit discovery to R2 and serves the snapshot without another network request", async () => {
    const fetcher = catalogues(
      [{ id: "snapshot-vendor/cc-model", name: "Snapshot CC", context_length: 128000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "snapshot-vendor/or-model", context_length: 96000, architecture: textChat, pricing: { prompt: "0.000001", completion: "0.000002" },
        supported_parameters: ["reasoning"], reasoning: { mandatory: true, supported_efforts: ["minimal", "high"] }, openRouterReasoningEffort: "high" }],
    );
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    const refreshed = await refreshModelCatalog(env);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(bucket.put.mock.calls[0] && bucket.put.mock.calls[0][0]).toBe("catalog/models.json");
    const stored = bucket.stored() as unknown as Record<string, unknown>;
    expect(typeof stored["updatedAt"]).toBe("string");
    expect(Number.isFinite(Date.parse(String(stored["updatedAt"])))).toBe(true);
    expect(stored["warnings"]).toEqual([]);
    expect(stored).not.toHaveProperty("gatewayId");
    const storedModels = stored["models"] as unknown[];
    expect(storedModels.length).toBeGreaterThanOrEqual(2);
    const storedProviders = stored["providers"] as unknown[];
    expect(Array.isArray(storedProviders)).toBe(true);
    expect(storedProviders.length).toBe(3);
    const storedRouter = (storedModels as Record<string, unknown>[]).find(model => model.id === "snapshot-vendor/or-model");
    if (!storedRouter) throw new Error("The stored OpenRouter fixture is missing.");
    expect(storedRouter.openRouterReasoningEfforts).toEqual(["minimal", "high"]);
    expect(storedRouter).not.toHaveProperty("openRouterReasoningEffort");
    // Even an extra field in a saved row cannot supply an owner-selected profile.
    storedRouter.openRouterReasoningEffort = "high";
    fetcher.mockClear();
    const read = await readModelCatalog(env);
    expect(read).toEqual(refreshed);
    expect(read.snapshot.refreshNeeded).toBe(false);
    const admitted = await requireAvailableModel(env, "gateway:openrouter/snapshot-vendor/or-model");
    expect(admitted.openRouterReasoningEfforts).toEqual(["minimal", "high"]);
    expect(admitted).not.toHaveProperty("openRouterReasoningEffort");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates saved choice bounds and drops choices when the configured official root changes", async () => {
    const providers = defaultProviders();
    const row = { route: "gateway:openrouter/stored/efforts", id: "stored/efforts", label: "Stored efforts",
      contextTokens: 64000, maxOutputTokens: 8192, checkedOn: "2026-11-08", enabled: true };
    const snapshot = { updatedAt: "2026-11-08T00:00:00Z", warnings: [], providers };
    const network = vi.fn(async () => { throw new Error("Catalogue reads must not discover or infer."); });
    vi.stubGlobal("fetch", network);
    for (const choices of [[], ["high", "high"], ["high", "bad value"], ["x".repeat(33)], Array.from({ length: 17 }, (_, i) => "e" + i)]) {
      const bucket = fakeBucket({ ...snapshot, models: [{ ...row, openRouterReasoningEfforts: choices }] });
      const read = await readModelCatalog(fixtureEnv(bucket.binding));
      expect(read.snapshot.refreshNeeded).toBe(true);
      expect(read.models.every(model => model.openRouterReasoningEfforts === undefined)).toBe(true);
    }
    const bucket = fakeBucket({ ...snapshot, models: [{ ...row, openRouterReasoningEfforts: ["high"] }] });
    const changedProviders = providers.map(provider => {
      if (provider.id !== "openrouter") return provider;
      const changed = { ...provider, baseUrl: "https://vendor.example/api/v1" };
      delete changed.dataCollection;
      return changed;
    });
    const read = await readModelCatalog(fixtureEnv(bucket.binding, { providers: changedProviders }));
    expect(read.models.find(model => model.route === row.route)).toMatchObject({ enabled: false });
    expect(read.models.find(model => model.route === row.route)).not.toHaveProperty("openRouterReasoningEfforts");
    expect(network).not.toHaveBeenCalled();
  });

  it("preserves a previous provider slice when an explicit refresh partially fails", async () => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    catalogues(
      [{ id: "snapshot-vendor/old-cc", context_length: 64000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "snapshot-vendor/old-or", context_length: 64000, architecture: textChat }],
    );
    await refreshModelCatalog(env);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === CC) return new Response("private upstream body", { status: 503 });
      if (url === OR) return Response.json({ data: [{ id: "snapshot-vendor/new-or", context_length: 64000, architecture: textChat }] });
      throw new Error("Unexpected metadata endpoint");
    });
    vi.stubGlobal("fetch", fetcher);
    const refreshed = await refreshModelCatalog(env);
    const gatewayModels = refreshed.models.filter((model) => model.route.indexOf("gateway:") === 0);
    const routes = gatewayModels.map((model) => model.route);
    expect(routes).toEqual(expect.arrayContaining(["gateway:command-code/snapshot-vendor/old-cc", "gateway:openrouter/snapshot-vendor/new-or"]));
    expect(routes.indexOf("gateway:openrouter/snapshot-vendor/old-or") >= 0).toBe(false);
    expect(refreshed.warnings).toEqual([expect.stringContaining("command-code model catalogue")]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(bucket.stored())).not.toContain("private upstream body");
  });

  it("deduplicates exact native IDs without collapsing slash/hyphen identities or borrowing metadata", async () => {
    const row = Object.freeze({ id: "new-vendor/model", name: "First raw row", context_length: 100000, max_output_tokens: 12000, supported_endpoints: ["/chat/completions"] });
    catalogues([row, row, { id: "new-vendor-model", name: "First raw row", context_length: 100000, supported_endpoints: ["/chat/completions"] }], []);
    const models = await discoverGatewayModels(defaultProviders());
    expect(models.map((model) => [model.route, model.id])).toEqual([
      ["gateway:command-code/new-vendor/model", "new-vendor/model"],
      ["gateway:command-code/new-vendor-model", "new-vendor-model"],
    ]);
    expect(models[0] && models[0].maxOutputTokens).toBe(12000);
    expect(models[1] && models[1].maxOutputTokens).toBeNull();
    expect(models.every((model) => !("inputMicrousdPerMillion" in model) && !("cachedMicrousdPerMillion" in model) && !("outputMicrousdPerMillion" in model))).toBe(true);
    expect(row.id).toBe("new-vendor/model");
  });

  it("rejects oversized streamed metadata instead of reading or publishing a truncated catalogue", async () => {
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === CC
      ? new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
      })) : Response.json({ data: [{ id: "surviving/model", architecture: textChat }] })));
    const warnings: string[] = [];
    const seen: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { seen.push(pid); warnings.push(message); })).toEqual([
      expect.objectContaining({ route: "gateway:openrouter/surviving/model" }),
    ]);
    expect(warnings).toEqual([expect.stringContaining("command-code")]);
    expect(seen).toEqual(["command-code"]);
    expect(cancelled).toBe(true);
  });

  it("rejects an over-bound raw roster instead of silently truncating or deduplicating it under the limit", async () => {
    const big: unknown[] = [];
    for (let i = 0; i < 2001; i++) big.push({ id: "provider/same-id" });
    catalogues(big, [{ id: "surviving/model", architecture: textChat }]);
    const warnings: string[] = [];
    const seen: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { seen.push(pid); warnings.push(message); })).toEqual([
      expect.objectContaining({ route: "gateway:openrouter/surviving/model" }),
    ]);
    expect(warnings).toEqual([expect.stringContaining("command-code")]);
    expect(seen).toEqual(["command-code"]);
  });

  it.each(["command-code", "openrouter"] as const)("retains the other provider with an explicit warning when %s is unavailable", async (failed) => {
    const survivor = failed === "command-code" ? "openrouter" : "command-code";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === (failed === "command-code" ? CC : OR)
      ? new Response("private upstream failure details", { status: 503 })
      : Response.json({ data: [{ id: "new-vendor/live-model", context_length: 64000, architecture: textChat, supported_endpoints: ["/chat/completions"] }] })));
    const warnings: string[] = [];
    const seen: string[] = [];
    const models = await discoverGatewayModels(defaultProviders(), (pid, message) => { seen.push(pid); warnings.push(message); });
    expect(models).toEqual([expect.objectContaining({ route: "gateway:" + survivor + "/new-vendor/live-model", enabled: true })]);
    expect(warnings).toEqual([failed + " model catalogue is unavailable (HTTP 503)."]);
    expect(seen).toEqual([failed]);
    expect(JSON.stringify(warnings)).not.toContain("private upstream failure details");
  });

  it("distinguishes two provider failures from a complete empty catalogue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("private network details"); }));
    const warnings: string[] = [];
    const seen: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { seen.push(pid); warnings.push(message); })).toEqual([]);
    expect(warnings).toEqual(["openrouter model catalogue is unavailable.", "command-code model catalogue is unavailable."]);
    expect(seen).toEqual(["openrouter", "command-code"]);
    catalogues([], []);
    const emptyWarnings: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { emptyWarnings.push(message); void pid; })).toEqual([]);
    expect(emptyWarnings).toEqual([]);
  });

  it("reports a fetch timeout as a timeout without leaking details", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === CC) throw new DOMException("signal timed out", "TimeoutError");
      return Response.json({ data: [{ id: "surviving/model", architecture: textChat }] });
    }));
    const warnings: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { warnings.push(message); void pid; })).toEqual([
      expect.objectContaining({ route: "gateway:openrouter/surviving/model" }),
    ]);
    expect(warnings).toEqual(["command-code model catalogue request timed out."]);
    expect(JSON.stringify(warnings)).not.toContain("signal timed out");
  });

  it("distinguishes an aborted catalogue body from malformed JSON with HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === CC) {
        return new Response(new ReadableStream({
          start(controller) { controller.error(new DOMException("stalled body aborted", "AbortError")); },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === OR) return new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } });
      throw new Error("Unexpected metadata endpoint");
    }));
    const warnings: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { warnings.push(message); void pid; })).toEqual([]);
    expect(warnings).toEqual(["openrouter model catalogue is malformed.", "command-code model catalogue request timed out."]);
    expect(JSON.stringify(warnings)).not.toContain("stalled body aborted");
    expect(JSON.stringify(warnings)).not.toContain("not-json");
    expect(JSON.stringify(warnings)).not.toContain("(HTTP 200)");
  });

  it("skips disabled providers during discovery without calling their endpoints", async () => {
    const fetcher = catalogues(
      [{ id: "should-stay-hidden/cc-model", context_length: 64000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "visible/or-model", context_length: 64000, architecture: textChat }],
    );
    const providers = defaultProviders().map((p) => p.id === "command-code" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: p.baseUrl, enabled: false } : p);
    const warnings: string[] = [];
    const models = await discoverGatewayModels(providers, (pid, message) => { warnings.push(message); void pid; });
    expect(models.map((m) => m.route)).toEqual(["gateway:openrouter/visible/or-model"]);
    expect(warnings).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0] && fetcher.mock.calls[0][0])).toBe(OR);
  });
  // Verified live shape 2026-10-29: Opencode Go returns minimal public OpenAI rows.
  it("keeps verified minimal OpenAI rows selectable with unknown bounds until admission", async () => {
    const goBase = "https://opencode.ai/zen/go/v1";
    const providers: ModelProvider[] = [
      { id: "opencode-go", type: "openai-compatible", gatewaySlug: "custom-opencode-go", gatewayPath: "v1", baseUrl: goBase, enabled: true },
    ];
    const rows = [
      { id: "hy3", object: "model", created: 1793240171, owned_by: "opencode" },
      { id: "muse-spark-1.3-contributor", object: "model", created: 1793240171, owned_by: "opencode" },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === goBase + "/models") return Response.json({ object: "list", data: rows });
      throw new Error("Unexpected metadata endpoint");
    }));
    const models = await discoverGatewayModels(providers);
    expect(models).toEqual([
      expect.objectContaining({ route: "gateway:opencode-go/hy3", id: "hy3", label: "hy3", contextTokens: null, maxOutputTokens: null, enabled: true }),
      expect.objectContaining({ route: "gateway:opencode-go/muse-spark-1.3-contributor", contextTokens: null, enabled: true }),
    ]);
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding, { providers });
    await refreshModelCatalog(env);
    await expect(requireAvailableModel(env, "gateway:opencode-go/hy3")).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });
});

describe("go provider metadata catalogue", () => {
  const GO_BASE = "https://opencode.ai/inference/go";
  const GO_MODELS = "https://opencode.ai/inference/go/v1/models";
  const GO_FEED = "https://models.dev/api.json";
  function goProviders(): ModelProvider[] {
    return [{ id: "opencode-go", type: "openai-compatible", gatewaySlug: "custom-opencode-go", gatewayPath: "v1", baseUrl: GO_BASE, modelsUrl: GO_MODELS, metadataUrl: GO_FEED, enabled: true }];
  }
  function liveRows(): unknown[] {
    return [
      { id: "hy3", object: "model", created: 1793240171, owned_by: "opencode" },
      { id: "muse-spark-1.3-contributor", object: "model", created: 1793240171, owned_by: "opencode" },
      { id: "claude-haiku-5-5", object: "model", created: 1793240171, owned_by: "opencode" },
      { id: "brand-new/live-model", object: "model", created: 1793240171, owned_by: "opencode" },
    ];
  }
  function feedDoc(): unknown {
    return {
      "opencode-go": {
        npm: "@ai-sdk/openai-compatible",
        api: "https://opencode.ai/inference/go/openai/v1",
        models: {
          hy3: { limit: { context: 256000, input: 192000, output: 128000 }, modalities: { input: ["text"], output: ["text"] }, temperature: true, structured_output: true },
          "muse-spark-1.3-contributor": { limit: { context: 1048576, output: 65536 }, modalities: { input: ["text", "image"], output: ["text"] }, temperature: true, provider: { npm: "@ai-sdk/openai", api: "https://opencode.ai/inference/go/openai/v1" } },
          "claude-haiku-5-5": { limit: { context: 1000000, output: 128000 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, temperature: false, structured_output: true, provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/go/anthropic/v1" } },
          "ghost-only/meta-model": { limit: { context: 1000, output: 100 }, modalities: { input: ["text"], output: ["text"] }, temperature: true },
        },
      },
      kilo: { npm: "@ai-sdk/openai-compatible", api: "https://ai-gateway.kilo.ai/api/v1", models: {} },
    };
  }
  function stubFeed(rows: unknown[], doc: unknown) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GO_MODELS) return Response.json({ object: "list", data: rows });
      if (url === GO_FEED) return Response.json(doc);
      throw new Error("Unexpected metadata endpoint");
    });
  }

  it("joins only literal reasoning booleans and leaves conflicting evidence unknown", async () => {
    const cases: Array<{ id: string; live?: unknown; metadata?: boolean; expected?: boolean }> = [
      { id: "dual-positive", live: true, metadata: true, expected: true },
      { id: "dual-negative", live: false, metadata: false, expected: false },
      { id: "live-only", live: true, expected: true },
      { id: "metadata-only", metadata: true, expected: true },
      { id: "live-negative", live: false, expected: false },
      { id: "metadata-negative", metadata: false, expected: false },
      { id: "conflict-positive", live: true, metadata: false },
      { id: "conflict-negative", live: false, metadata: true },
      { id: "malformed-string", live: "true" }, { id: "malformed-number", live: 1 },
      { id: "gpt-5" }, { id: "effort-only" },
    ];
    const rows = cases.map(entry => ({ id: entry.id, reasoningSupported: true,
      capabilities: { reasoning: { supported: entry.live, supportedEfforts: ["minimal", "max"] } } }));
    const models = Object.fromEntries(cases.map(entry => [entry.id, { limit: { context: 64000, output: 8192 },
      ...(entry.metadata === undefined ? {} : { reasoning: entry.metadata }) }]));
    vi.stubGlobal("fetch", stubFeed(rows, { "opencode-go": { npm: "@ai-sdk/openai", api: GO_BASE + "/openai/v1", models } }));
    const discovered = await discoverGatewayModels(goProviders());
    expect(discovered).toHaveLength(cases.length);
    for (const entry of cases) {
      const model = discovered.find(model => model.id === entry.id);
      if (entry.expected === undefined) expect(model).not.toHaveProperty("supportsReasoning");
      else expect(model?.supportsReasoning).toBe(entry.expected);
      expect(model).not.toHaveProperty("structuredReasoningEffort");
    }
  });

  it.each([undefined, false, true])("preserves admitted reasoning=%s across a Refresh without enriching stored reads", async supportsReasoning => {
    const providers = goProviders(), route = "gateway:opencode-go/opaque-fixture";
    const storedModel = { route, id: "opaque-fixture", label: "Opaque", contextTokens: 64000, maxOutputTokens: 8192,
      outputReserveTokens: 8192, checkedOn: "2026-11-09", enabled: true, apiProtocol: "openai-responses", apiBaseUrl: GO_BASE + "/openai/v1",
      ...(supportsReasoning === undefined ? {} : { supportsReasoning }) };
    const bucket = fakeBucket({ updatedAt: "2026-11-09T00:00:00Z", warnings: [], providers, models: [storedModel] });
    const env = fixtureEnv(bucket.binding, { providers });
    const refreshedFlag = supportsReasoning !== true;
    const network = vi.fn(stubFeed([{ id: "opaque-fixture", capabilities: { reasoning: { supported: refreshedFlag } } }], {
      "opencode-go": { npm: "@ai-sdk/openai", api: GO_BASE + "/openai/v1",
        models: { "opaque-fixture": { limit: { context: 64000, output: 8192 }, reasoning: refreshedFlag } } },
    }));
    vi.stubGlobal("fetch", network);
    const admitted = await requireAvailableModel(env, route);
    const before = JSON.stringify(admitted);
    const read = await readModelCatalog(env);
    expect(read.models.find(model => model.route === route)?.supportsReasoning).toBe(supportsReasoning);
    if (supportsReasoning === undefined) expect(admitted).not.toHaveProperty("supportsReasoning");
    expect(network).not.toHaveBeenCalled(); expect(bucket.put).not.toHaveBeenCalled();
    await refreshModelCatalog(env);
    const next = await requireAvailableModel(env, route);
    expect(next.supportsReasoning).toBe(refreshedFlag);
    expect(JSON.stringify(admitted)).toBe(before);
    expect(network).toHaveBeenCalledTimes(2); expect(bucket.put).toHaveBeenCalledTimes(1);
    const invalid = fakeBucket({ updatedAt: "2026-11-09T00:00:00Z", warnings: [], providers,
      models: [{ ...storedModel, supportsReasoning: "true" }] });
    expect((await readModelCatalog(fixtureEnv(invalid.binding, { providers }))).models.some(model => model.route === route)).toBe(false);
    expect(network).toHaveBeenCalledTimes(2); expect(invalid.put).not.toHaveBeenCalled();
  });

  it.each(["true", 1, {}, []])("rejects malformed metadata reasoning without coercion: %j", async reasoning => {
    vi.stubGlobal("fetch", stubFeed([{ id: "opaque-fixture" }], { "opencode-go": { npm: "@ai-sdk/openai", api: GO_BASE + "/openai/v1",
      models: { "opaque-fixture": { limit: { context: 64000, output: 8192 }, reasoning } } } }));
    const warnings: string[] = [];
    expect(await discoverGatewayModels(goProviders(), (_id, warning) => warnings.push(warning))).toEqual([]);
    expect(warnings).toEqual(["opencode-go model metadata is unavailable or malformed."]);
  });

  it("enriches image support without turning missing modalities into false", async () => {
    const limits = { limit: { context: 64000, output: 1024 } };
    vi.stubGlobal("fetch", stubFeed([
      { id: "fixture/one" },
      { id: "fixture/two" },
      { id: "fixture/three" },
      { id: "fixture/four", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
    ], {
      "opencode-go": {
        npm: "@ai-sdk/openai-compatible", api: GO_BASE + "/openai/v1",
        models: {
          "fixture/one": { ...limits, modalities: { input: ["text", "image"], output: ["text"] } },
          "fixture/two": { ...limits, modalities: { input: ["text"], output: ["text"] } },
          "fixture/three": limits,
          "fixture/four": limits,
        },
      },
    }));
    const models = await discoverGatewayModels(goProviders());
    expect(models.map((model) => model.supportsImages)).toEqual([true, false, undefined, true]);
    expect(models[2]).not.toHaveProperty("supportsImages");
    expect(models.every((model) => model.enabled)).toBe(true);
  });

  it("joins published bounds, wire and api base for live rows only", async () => {
    vi.stubGlobal("fetch", stubFeed(liveRows(), feedDoc()));
    const warnings: string[] = [];
    const models = await discoverGatewayModels(goProviders(), (pid, message) => { warnings.push(message); void pid; });
    expect(models).toHaveLength(4);
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("hy3")).toMatchObject({ contextTokens: 192000, contextWindowTokens: 256000, maxOutputTokens: 128000, apiProtocol: "openai-chat", apiBaseUrl: "https://opencode.ai/inference/go/openai/v1", supportsTemperature: true, responseFormat: true, structuredOutputs: true, enabled: true });
    expect(byId.get("muse-spark-1.3-contributor")).toMatchObject({ contextTokens: 1048576, maxOutputTokens: 65536, apiProtocol: "openai-responses", apiBaseUrl: "https://opencode.ai/inference/go/openai/v1", enabled: true });
    expect(byId.get("claude-haiku-5-5")).toMatchObject({ contextTokens: 1000000, maxOutputTokens: 128000, apiProtocol: "anthropic", apiBaseUrl: "https://opencode.ai/inference/go/anthropic/v1", enabled: true });
    expect(byId.get("claude-haiku-5-5")).not.toHaveProperty("supportsTemperature");
    expect(byId.get("brand-new/live-model")).toMatchObject({ contextTokens: null, maxOutputTokens: null, enabled: true });
    expect(byId.get("brand-new/live-model")).not.toHaveProperty("apiProtocol");
    expect(byId.get("brand-new/live-model")).not.toHaveProperty("apiBaseUrl");
    expect(models.some((model) => model.id === "ghost-only/meta-model")).toBe(false);
    expect(warnings).toEqual([]);
  });




  it("admits only same-origin descendant api bases before dispatch", async () => {
    const providers = goProviders();
    const stored = {
      updatedAt: new Date().toISOString(),
      warnings: [],
      providers,
      models: [
        { route: "gateway:opencode-go/hy3", id: "hy3", label: "hy3", contextTokens: 192000, maxOutputTokens: 128000, checkedOn: "2026-10-29", enabled: true, apiProtocol: "openai-chat", apiBaseUrl: "https://opencode.ai/inference/go/openai/v1" },
        { route: "gateway:opencode-go/sibling", id: "sibling", label: "sibling", contextTokens: 192000, maxOutputTokens: 128000, checkedOn: "2026-10-29", enabled: true, apiProtocol: "openai-chat", apiBaseUrl: "https://opencode.ai/inference/go-other/openai/v1" },
        { route: "gateway:opencode-go/foreign", id: "foreign", label: "foreign", contextTokens: 192000, maxOutputTokens: 128000, checkedOn: "2026-10-29", enabled: true, apiProtocol: "openai-chat", apiBaseUrl: "https://evil.example.com/v1" },
      ],
    };
    const bucket = fakeBucket(stored);
    const env = fixtureEnv(bucket.binding, { providers });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("admission must not discover"); }));
    await expect(requireAvailableModel(env, "gateway:opencode-go/hy3")).resolves.toMatchObject({ route: "gateway:opencode-go/hy3" });
    await expect(requireAvailableModel(env, "gateway:opencode-go/sibling")).rejects.toMatchObject({ code: "unavailable", status: 503 });
    await expect(requireAvailableModel(env, "gateway:opencode-go/foreign")).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("preserves the last good provider slice when an HTTP 200 feed has a malformed live model entry", async () => {
    const providers = goProviders();
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding, { providers });
    vi.stubGlobal("fetch", stubFeed(liveRows(), feedDoc()));
    const before = await refreshModelCatalog(env);
    const prior = before.models.find((model) => model.route === "gateway:opencode-go/hy3");
    expect(prior).toMatchObject({ contextTokens: 192000, apiProtocol: "openai-chat", apiBaseUrl: "https://opencode.ai/inference/go/openai/v1" });
    if (!prior) throw new Error("Expected the initial refreshed model slice.");

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GO_MODELS) return Response.json({ object: "list", data: liveRows() }, { status: 200 });
      if (url === GO_FEED) return Response.json({
        "opencode-go": {
          npm: "@ai-sdk/openai-compatible",
          api: "https://opencode.ai/inference/go/openai/v1",
          models: { hy3: null },
        },
      }, { status: 200 });
      throw new Error("Unexpected metadata endpoint");
    }));

    const after = await refreshModelCatalog(env);
    expect(after.warnings).toContain("opencode-go model metadata is unavailable or malformed.");
    expect(after.models.find((model) => model.route === "gateway:opencode-go/hy3")).toEqual(prior);
  });
});

describe("native contradictory catalogue entries", () => {
  it("does not choose one of contradictory property entries", () => {
    type NativeRow = Awaited<ReturnType<Ai["models"]>>[number];
    const row = (properties: unknown[]): NativeRow => ({ id: "catalogue-uuid", name: "@cf/vendor/new-chat-model",
      task: { name: "Text Generation" }, properties } as unknown as NativeRow);
    expect(nativeModel(row([
      { property_id: "context_window", value: "1048576" },
      { property_id: "context_window", value: "128000" },
    ]), "2026-10-27")?.contextTokens).toBeNull();
  });

  it("selects high only from one reasoning_effort property advertising high", () => {
    type NativeRow = Awaited<ReturnType<Ai["models"]>>[number];
    const row = (reasoningProperties: unknown[]): NativeRow => ({ id: "catalogue-uuid", name: "@cf/zai-org/glm-5.3",
      task: { name: "Text Generation" }, properties: [{ property_id: "context_window", value: "1048576" }, ...reasoningProperties] } as unknown as NativeRow);
    const native = (reasoningProperties: unknown[]) => nativeModel(row(reasoningProperties), "2026-11-07");
    expect(native([{ property_id: "reasoning_effort", value: { supported_efforts: ["low", "high", "max"] } }]))
      .toMatchObject({ nativeReasoningEffort: "high" });
    expect(native([])).not.toHaveProperty("nativeReasoningEffort");
    expect(native([{ property_id: "reasoning_effort", value: { supported_efforts: ["low", "max"] } }]))
      .not.toHaveProperty("nativeReasoningEffort");
    expect(native([
      { property_id: "reasoning_effort", value: { supported_efforts: ["high"] } },
      { property_id: "reasoning_effort", value: { supported_efforts: ["low"] } },
    ])).not.toHaveProperty("nativeReasoningEffort");
  });

  it("maps one published boolean vision property to supportsImages; absent/non-boolean/duplicate stays unknown", () => {
    type NativeRow = Awaited<ReturnType<Ai["models"]>>[number];
    const row = (visionProperties: unknown[]): NativeRow => ({ id: "catalogue-uuid", name: "@cf/meta/vision-model",
      task: { name: "Text Generation" }, properties: [{ property_id: "context_window", value: "131000" }, ...visionProperties] } as unknown as NativeRow);
    const native = (visionProperties: unknown[]) => nativeModel(row(visionProperties), "2026-11-07");
    expect(native([{ property_id: "vision", value: true }])).toMatchObject({ supportsImages: true });
    expect(native([{ property_id: "vision", value: false }])).toMatchObject({ supportsImages: false });
    expect(native([{ property_id: "vision", value: "true" }])).toMatchObject({ supportsImages: true });
    expect(native([{ property_id: "vision", value: "false" }])).toMatchObject({ supportsImages: false });
    expect(native([])).not.toHaveProperty("supportsImages");
    expect(native([{ property_id: "vision", value: "TRUE" }])).not.toHaveProperty("supportsImages");
    expect(native([{ property_id: "vision", value: 1 }])).not.toHaveProperty("supportsImages");
    expect(native([
      { property_id: "vision", value: true },
      { property_id: "vision", value: false },
    ])).not.toHaveProperty("supportsImages");
  });
});

describe("frozen gateway protocol transports", () => {
  const GO_PROVIDER = { id: "opencode-go", type: "openai-compatible", gatewaySlug: "custom-opencode-go", gatewayPath: "", baseUrl: "https://opencode.ai/inference/go", enabled: true };
  function goModel(nativeId: string, apiProtocol: NonNullable<ModelSpec["apiProtocol"]>, apiBaseUrl: string): ModelSpec {
    return { contextTokens: 1048576, maxOutputTokens: 8192, outputReserveTokens: 8192, checkedOn: "2026-10-26", enabled: true,
      route: "gateway:opencode-go/" + nativeId, id: nativeId, label: nativeId, apiProtocol, apiBaseUrl,
      routing: { provider: { ...GO_PROVIDER }, gatewayId: "test-gw" } } as unknown as ModelSpec;
  }
  function stubGateway() {
    const fetchStub = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ error: { message: "stubbed" } }), { status: 400, headers: { "Content-Type": "application/json" } }));
    return { fetch: fetchStub, binding: { fetch: fetchStub } as unknown as Env["AI"] };
  }
  function testDb() {
    const prepared: string[] = [];
    const DB = { prepare(sql: string) { prepared.push(sql); return { first: async () => ({ gatewayId: "test-gw" }) }; } } as unknown as Env["DB"];
    return { DB, prepared };
  }
  const cases = [
    { protocol: "openai-chat", ownerBase: "https://opencode.ai/inference/go/openai/v1", suffix: "/openai/v1/chat/completions" },
    { protocol: "openai-responses", ownerBase: "https://opencode.ai/inference/go/openai/v1", suffix: "/openai/v1/responses" },
    { protocol: "anthropic", ownerBase: "https://opencode.ai/inference/go/anthropic/v1", suffix: "/anthropic/v1/messages" },
    { protocol: "google", ownerBase: "https://opencode.ai/inference/go/google/v1beta", suffix: "/google/v1beta/models/" },
  ] as const;
  it.each(cases.flatMap(entry => [undefined, "named-fixture"].map(keyAlias => ({ ...entry, keyAlias }))))("routes $protocol onto the frozen custom Gateway path without credentials; alias=$keyAlias", async ({ protocol, ownerBase, suffix, keyAlias }) => {
    const { fetch: fetchStub, binding } = stubGateway();
    const { DB, prepared } = testDb();
    const nativeId = "probe-" + protocol;
    const model = goModel(nativeId, protocol, ownerBase);
    if (keyAlias !== undefined && model.routing) model.routing.provider.keyAlias = keyAlias;
    const languageModel = await resolveModelTransport({ AI: binding, DB }, model, "sess-" + protocol);
    const controller = new AbortController();
    if (protocol === "google") {
      try { await (await streamText({ model: languageModel, prompt: "hi", maxRetries: 0, abortSignal: controller.signal })).text; } catch { /* stubbed 400 surfaces here */ }
    } else {
      await expect(generateText({ model: languageModel, prompt: "hi", maxRetries: 0, abortSignal: controller.signal })).rejects.toThrow();
    }
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const call = fetchStub.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error("expected Gateway call");
    const url = String(call[0]);
    const init = call[1] as { method?: unknown; headers?: Record<string, string>; body?: unknown; signal?: unknown };
    expect(url.startsWith("https://workers-binding.ai/ai-gateway/gateways/test-gw/custom-opencode-go" + suffix)).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(controller.signal);
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", "x-session-affinity": "sess-" + protocol, "cf-aig-no-wholesale": "true", "cf-aig-max-attempts": "1", "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false" });
    const headers = new Headers(init.headers);
    expect(headers.get("cf-aig-byok-alias")).toBe(keyAlias ?? null);
    expect(headers.get("user-agent")).toBe("EliotResearch/0.1.0");
    expect(headers.get("x-opencode-session")).toBe("sess-" + protocol);
    expect(JSON.stringify({ url, headers: init.headers }).toLowerCase()).not.toMatch(/authorization|bearer|x-api-key|x-goog-api-key|sk-/);
    expect(url).not.toMatch(/[?&](key|apikey|api_key|x-goog-api-key)=/i);
    const sent = JSON.parse(String(init.body)) as { model?: unknown; store?: unknown; previous_response_id?: unknown };
    if (protocol === "google") { expect(url).toContain(nativeId); }
    else { expect(sent.model).toBe(nativeId); }
    if (protocol === "openai-responses") { expect(sent.store).toBe(false); expect(sent.previous_response_id).toBeUndefined(); }
    if (protocol === "anthropic") { expect(init.headers?.["anthropic-version"]).toBe("2023-06-01"); }
    if (protocol === "google") { expect(url).toContain(":streamGenerateContent"); expect(url).toContain("alt=sse"); }
    expect(prepared).toEqual([]);
    for (const session of ["sess-" + protocol, "another-caller"]) {
      const next = await resolveModelTransport({ AI: binding, DB }, model, session);
      if (protocol === "google") {
        await expect(streamText({ model: next, prompt: "offline", maxRetries: 0 }).text).rejects.toThrow();
      } else await expect(generateText({ model: next, prompt: "offline", maxRetries: 0 })).rejects.toThrow();
    }
    expect(fetchStub.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-opencode-session")))
      .toEqual(["sess-" + protocol, "sess-" + protocol, "another-caller"]);
  });

  it.each(["native", "compatible", "protocol-chat"] as const)("keeps caller affinity without a Go header and stops credential rejection on %s", async path => {
    const network = vi.fn().mockRejectedValue(new Error("Unexpected provider network request"));
    vi.stubGlobal("fetch", network);
    const provider: ModelProvider = { id: "router", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1",
      gatewaySlug: path === "native" ? "openrouter" : "custom-router", gatewayPath: "v1", enabled: true, keyAlias: "named-fixture" };
    const model: ModelSpec = { ...MODELS[0], route: "gateway:router/offline", id: "offline", label: "Offline", contextTokens: 64000,
      maxOutputTokens: 8192, checkedOn: "2026-11-09", enabled: true, routing: { provider, gatewayId: "fixture" },
      ...(path === "protocol-chat" ? { apiProtocol: "openai-chat", apiBaseUrl: provider.baseUrl ?? "" } : {}) };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 401 }));
    const env = { AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] };
    for (const [index, session] of ["chat-fixture", "chat-fixture", "ocr-job-fixture"].entries()) {
      const transport = await resolveModelTransport(env, model, session);
      await expect(generateText({ model: transport, prompt: "offline", maxOutputTokens: 8, maxRetries: 0 })).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(index + 1);
      const request = fetch.mock.calls[index];
      if (!request) throw new Error("The Gateway request is missing.");
      expect(String(request[0])).toMatch(/^https:\/\/workers-binding\.ai\/ai-gateway\/gateways\//);
      const headers = new Headers(request[1]?.headers);
      expect(headers.get("cf-aig-byok-alias")).toBe("named-fixture");
      expect(headers.get("user-agent")).toBe("EliotResearch/0.1.0");
      expect(headers.has("x-opencode-session")).toBe(false);
      expect(headers.get("x-session-affinity")).toBe(session);
      expect(headers.has("authorization")).toBe(false);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    { baseUrl: "https://opencode.ai/inference/go", go: true },
    { baseUrl: "https://opencode.ai/inference/go/vendor", go: true },
    { baseUrl: "https://opencode.ai/inference", go: false },
    { baseUrl: "https://opencode.ai/inference/goo", go: false },
    { baseUrl: "https://opencode.ai/goto/goo", go: false },
    { baseUrl: "https://opencode.ai.evil.example/inference/go", go: false },
    { baseUrl: "https://opencode.ai:8443/inference/go", go: false },
  ].flatMap(entry => [false, true].map(protocol => ({ ...entry, protocol }))))(
    "scopes Go headers by root, independently of provider/model names: $baseUrl protocol=$protocol", async ({ baseUrl, go, protocol }) => {
      const { fetch, binding } = stubGateway();
      const provider: ModelProvider = { ...GO_PROVIDER, id: go ? "unrelated-name" : "opencode-go", type: "openai-compatible", baseUrl };
      const model: ModelSpec = { ...MODELS[0], route: `gateway:${provider.id}/opencode-go-model`, id: "opencode-go-model",
        label: "Offline root boundary", contextTokens: 64000, maxOutputTokens: 8192, checkedOn: "2026-11-09", enabled: true,
        routing: { provider, gatewayId: "fixture" }, ...(protocol ? { apiProtocol: "openai-chat", apiBaseUrl: baseUrl } : {}) };
      const transport = await resolveModelTransport({ AI: binding, DB: {} as Env["DB"] }, model, "chat-existing-id");
      await expect(generateText({ model: transport, prompt: "offline", maxRetries: 0 })).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
      expect(headers.get("x-opencode-session")).toBe(go ? "chat-existing-id" : null);
      expect(headers.get("x-session-affinity")).toBe("chat-existing-id");
      expect(headers.get("user-agent")).toBe("EliotResearch/0.1.0");
    });

  it("sends deny, allow and legacy default-deny through every OpenRouter Chat transport", async () => {
    const network = vi.fn(async () => { throw new Error("Only the fake AI binding may receive requests"); });
    vi.stubGlobal("fetch", network);
    for (const baseUrl of ["https://openrouter.ai/api/v1", "https://OPENROUTER.AI/api/v1/"]) {
      for (const path of ["native", "compatible", "protocol-chat"] as const) {
        for (const policy of [undefined, "deny", "allow"] as const) {
          const provider: ModelProvider = { id: "openrouter", type: "openai-compatible", enabled: true,
            baseUrl, gatewaySlug: path === "native" ? "openrouter" : "custom-router",
            gatewayPath: "v1", ...(policy === undefined ? {} : { dataCollection: policy }) };
          const model: ModelSpec = { route: "gateway:openrouter/fixture/model", id: "fixture/model", label: "Fixture",
            contextTokens: 64000, maxOutputTokens: 8192, checkedOn: "2026-10-29", enabled: true,
            ...(path === "protocol-chat" ? { apiProtocol: "openai-chat", apiBaseUrl: baseUrl } : {}),
            routing: { provider, gatewayId: "test-gw" } };
          const { fetch: fetchStub, binding } = stubGateway();
          const { DB, prepared } = testDb();
          const transport = await resolveModelTransport({ AI: binding, DB }, model, "policy-fixture");
          await expect(generateText({ model: transport, prompt: "synthetic", maxRetries: 0 })).rejects.toThrow();
          expect(fetchStub, baseUrl + " " + path + " " + String(policy)).toHaveBeenCalledTimes(1);
          const request = fetchStub.mock.calls[0];
          if (!request) throw new Error("Expected the fake Gateway request");
          expect(new Headers(request[1]?.headers).has("cf-aig-byok-alias")).toBe(false);
          const sent = JSON.parse(String(request[1]?.body)) as Record<string, unknown>;
          expect(sent.provider, baseUrl + " " + path + " " + String(policy)).toMatchObject({
            data_collection: policy ?? "deny", allow_fallbacks: false, require_parameters: true,
          });
          expect(prepared).toEqual([]);
        }
      }
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps cached models ready after a policy-only save and dispatches the frozen admission choice", async () => {
    const providers = defaultProviders();
    const route = "gateway:openrouter/fixture/cached";
    const bucket = fakeBucket({ updatedAt: "2026-10-29T00:00:00.000Z", warnings: [], providers,
      models: [{ route, id: "fixture/cached", label: "Cached", contextTokens: 64000, maxOutputTokens: 8192, checkedOn: "2026-10-29", enabled: true }] });
    const env = fixtureEnv(bucket.binding, { providers });
    const network = vi.fn(async () => { throw new Error("Policy saves must not discover or infer"); });
    vi.stubGlobal("fetch", network);
    const before = await readModelCatalog(env);
    const snapshot = JSON.stringify(bucket.stored());
    await saveModelProviders(env, providers.map((p) => p.id === "openrouter" ? { ...p, dataCollection: "allow" as const } : p));
    const after = await readModelCatalog(env);
    expect(after.models).toEqual(before.models);
    expect(after.models.find((model) => model.route === route)).toMatchObject({ enabled: true, contextTokens: 64000 });
    expect(after.snapshot.refreshNeeded).toBe(false);
    const frozen = await requireAvailableModel(env, route);
    expect(frozen.routing?.provider.dataCollection).toBe("allow");
    await saveModelProviders(env, providers);
    expect((await requireAvailableModel(env, route)).routing?.provider.dataCollection).toBe("deny");
    expect(frozen.routing?.provider.dataCollection).toBe("allow");
    const prepare = vi.spyOn(env.DB, "prepare");
    const { fetch: fetchStub, binding } = stubGateway();
    const transport = await resolveModelTransport({ AI: binding, DB: env.DB }, frozen, "frozen-policy");
    await expect(generateText({ model: transport, prompt: "synthetic", maxRetries: 0 })).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const request = fetchStub.mock.calls[0];
    if (!request) throw new Error("Expected the frozen-policy fake Gateway request");
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({ provider: { data_collection: "allow" } });
    expect(prepare).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(JSON.stringify(bucket.stored())).toBe(snapshot);
  });
});

describe("provider configuration loader", () => {
  it("reads the migration seed shape through the real settings query", async () => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    const providers = await getModelProviders(env);
    expect(providers).toHaveLength(3);
    expect(providers.map((p) => p.id).sort()).toEqual(["command-code", "openrouter", "workers-ai"]);
    const cc = providers.filter((p) => p.id === "command-code")[0];
    expect(cc && cc.type).toBe("openai-compatible");
    expect(cc && cc.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
    const stored = JSON.parse(JSON.stringify(providers));
    expect(stored).toEqual(providers);
  });

  it("defaults a legacy missing OpenRouter policy to deny without saving and accepts explicit allow", async () => {
    const providers = defaultProviders();
    const legacy = providers.map((p) => { const copy = { ...p }; delete copy.dataCollection; return copy; });
    const env = fixtureEnv(fakeBucket().binding, { providers: legacy });
    const prepare = vi.spyOn(env.DB, "prepare");
    expect((await getModelProviders(env)).find((p) => p.id === "openrouter")?.dataCollection).toBe("deny");
    expect(prepare).toHaveBeenCalledExactlyOnceWith("SELECT model_providers_json AS providers FROM settings WHERE id=1");
    const allow = fixtureEnv(fakeBucket().binding, { providers: providers.map((p) => p.id === "openrouter"
      ? { ...p, baseUrl: "https://OPENROUTER.AI/api/v1/", dataCollection: "allow" as const } : p) });
    expect((await getModelProviders(allow)).find((p) => p.id === "openrouter")?.dataCollection).toBe("allow");
  });

  it("rejects missing, malformed, duplicate and non-https provider settings without inventing defaults", async () => {
    const bucket = fakeBucket();
    const dup = defaultProviders()[1] as ModelProvider;
    const bad: string[] = [
      "not-json",
      JSON.stringify(null),
      JSON.stringify(defaultProviders().concat([dup])),
      JSON.stringify(defaultProviders().map((p) => p.id === "openrouter" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: "http://openrouter.ai/api/v1", enabled: true } : p)),
      JSON.stringify(defaultProviders().map((p) => p.id === "openrouter" ? { ...p, dataCollection: "invalid" } : p)),
      JSON.stringify(defaultProviders().map((p) => p.id === "workers-ai" ? { ...p, dataCollection: "allow" } : p)),
      JSON.stringify(defaultProviders().map((p) => p.id === "command-code" ? { ...p, dataCollection: "allow" } : p)),
      JSON.stringify(defaultProviders().map((p) => p.id === "openrouter" ? { ...p, baseUrl: "https://openrouter.ai.evil.example/api/v1" } : p)),
    ];
    for (const raw of bad) {
      const env = fixtureEnv(bucket.binding, { providersRaw: raw });
      await expect(getModelProviders(env)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    }
  });

  it("routes workers-ai, gateway and unknown routes to the configured provider", () => {
    const providers = defaultProviders();
    expect(providerForRoute(providers, "workers-ai:@cf/vendor/model") && (providerForRoute(providers, "workers-ai:@cf/vendor/model") as ModelProvider).id).toBe("workers-ai");
    expect(providerForRoute(providers, "gateway:openrouter/vendor/model") && (providerForRoute(providers, "gateway:openrouter/vendor/model") as ModelProvider).id).toBe("openrouter");
    expect(providerForRoute(providers, "gateway:command-code/vendor/model") && (providerForRoute(providers, "gateway:command-code/vendor/model") as ModelProvider).id).toBe("command-code");
    expect(providerForRoute(providers, "gateway:unknown/vendor/model")).toBeUndefined();
  });
});

describe("authenticated OpenRouter catalogue discovery", () => {
  const userUrl = "https://openrouter.ai/api/v1/models/user";
  const gatewayUrl = "https://workers-binding.ai/ai-gateway/gateways/fixture-gateway/openrouter/v1/models/user";
  const provider: ModelProvider = { id: "owner-router", type: "openai-compatible", gatewaySlug: "openrouter", gatewayPath: "v1",
    baseUrl: "https://openrouter.ai/api/v1", dataCollection: "deny", enabled: true };
  const row = { id: "provider/filtered", context_length: 64000, architecture: textChat };

  it.each([undefined, userUrl, userUrl + "?limit=16&output_modalities=text"].flatMap(modelsUrl =>
    [undefined, "named-fixture"].map(keyAlias => ({ modelsUrl, keyAlias }))))("uses receiver-bound Gateway GET first for modelsUrl=$modelsUrl alias=$keyAlias despite public anonymous 200", async ({ modelsUrl, keyAlias }) => {
    const selected = { ...provider, ...(modelsUrl === undefined ? {} : { modelsUrl }), ...(keyAlias === undefined ? {} : { keyAlias }) };
    const publicFetch = vi.fn(async () => Response.json({ data: [{ ...row, id: "anonymous/unfiltered" }] }));
    vi.stubGlobal("fetch", publicFetch);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const gateway = { id: "fixture-gateway", ai: { fetch: vi.fn(async function (this: unknown, url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      expect(this).toBe(gateway.ai);
      expect(String(url)).toBe(gatewayUrl + (modelsUrl === undefined ? "" : new URL(modelsUrl).search));
      expect(init).toMatchObject({ method: "GET", redirect: "manual", headers: { accept: "application/json",
        "cf-aig-no-wholesale": "true", "cf-aig-max-attempts": "1", "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false" } });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(new Headers(init?.headers).get("cf-aig-byok-alias")).toBe(keyAlias ?? null);
      expect(init?.body).toBeUndefined();
      return Response.json({ data: [row] });
    }) } };
    try {
      const warnings: string[] = [];
      const models = await discoverGatewayModels([selected], (_id, warning) => warnings.push(warning), gateway);
      expect(models.map(model => model.route)).toEqual(["gateway:owner-router/" + row.id]);
      expect(warnings).toEqual([]);
      expect(gateway.ai.fetch).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(15000);
      expect(publicFetch).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });

  it("keeps the disconnected default public and honors explicit owner public catalogue URLs", async () => {
    const publicFetch = vi.fn(async (_url: RequestInfo | URL) => Response.json({ data: [row] }));
    vi.stubGlobal("fetch", publicFetch);
    const gateway = { id: "fixture-gateway", ai: { fetch: vi.fn(async () => { throw new Error("Public discovery must stay public."); }) } };
    for (const modelsUrl of [undefined, OR, "https://catalogue.example.com/models"]) {
      const selected = { ...provider, ...(modelsUrl === undefined ? {} : { modelsUrl }) };
      const models = await discoverGatewayModels([selected], undefined, modelsUrl === undefined ? undefined : gateway);
      expect(models.map(model => model.id)).toEqual([row.id]);
      expect(publicFetch.mock.calls.at(-1)?.[0]).toBe(modelsUrl ?? OR);
    }
    expect(publicFetch).toHaveBeenCalledTimes(3);
    expect(gateway.ai.fetch).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves the previous slice with a fixed warning when authenticated discovery cannot proceed (connected=%s)", async connected => {
    const selected = { ...provider, ...(connected ? {} : { modelsUrl: userUrl }) };
    const old = { route: "gateway:owner-router/previous/model", id: "previous/model", label: "Previous model", contextTokens: 64000,
      maxOutputTokens: 8192, checkedOn: "2026-11-08", enabled: true };
    const bucket = fakeBucket({ updatedAt: "2026-11-08T00:00:00Z", warnings: [], providers: [selected], models: [old] });
    const env = fixtureEnv(bucket.binding, { providers: [selected], gatewayId: connected ? "fixture-gateway" : null });
    const publicFetch = vi.fn(async () => Response.json({ data: [{ ...row, id: "anonymous/unfiltered" }] }));
    vi.stubGlobal("fetch", publicFetch);
    const gatewayFetch = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/key")
      ? Response.json({ data: { usage: 0, limit: null } })
      : new Response("PRIVATE_PROVIDER_BODY", { status: 503 }));
    Object.assign(env.AI, { fetch: gatewayFetch });
    const refreshed = await refreshModelCatalog(env);
    expect(refreshed.models.map(model => model.route)).toEqual([old.route]);
    expect((bucket.stored() as { models: unknown[] }).models).toEqual([old]);
    expect(refreshed.warnings).toContain(connected
      ? "owner-router model catalogue is unavailable (HTTP 503)."
      : "owner-router model catalogue requires a connected Gateway for authenticated discovery.");
    expect(JSON.stringify(refreshed)).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(gatewayFetch.mock.calls.filter(([url]) => String(url) === gatewayUrl)).toHaveLength(connected ? 1 : 0);
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("retains the same-provider public 401 fallback for other providers", async () => {
    const configured = defaultProviders().find(provider => provider.id === "command-code");
    if (!configured) throw new Error("The compatible provider fixture is missing.");
    const selected = { ...configured, modelsUrl: CC + "?limit=16" };
    const publicFetch = vi.fn(async () => new Response("PRIVATE_401_BODY", { status: 401 }));
    vi.stubGlobal("fetch", publicFetch);
    const gateway = { id: "fixture-gateway", ai: { fetch: vi.fn(async function (this: unknown, url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      expect(this).toBe(gateway.ai);
      expect(String(url)).toBe("https://workers-binding.ai/ai-gateway/gateways/fixture-gateway/custom-command-code/v1/models?limit=16");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ data: [{ ...row, supported_endpoints: ["/chat/completions"] }] });
    }) } };
    const models = await discoverGatewayModels([selected], undefined, gateway);
    expect(models.map(model => model.id)).toEqual([row.id]);
    expect(publicFetch).toHaveBeenCalledTimes(1);
    expect(gateway.ai.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("stored catalogue with provider snapshot", () => {
  it("preserves stored low on reads and replaces it with fresh native reasoning metadata on refresh", async () => {
    const workersAi = defaultProviders().filter((provider) => provider.type === "workers-ai");
    const route = "workers-ai:@cf/zai-org/glm-5.3-flash";
    const legacy = { route, id: "@cf/zai-org/glm-5.3-flash", label: "GLM 5.3 Flash", contextTokens: 1_048_576,
      contextWindowTokens: 1_048_576, maxOutputTokens: null, outputReserveTokens: 8192, supportsImages: true,
      nativeReasoningEffort: "low", checkedOn: "2026-10-30", enabled: true };
    const bucket = fakeBucket({ updatedAt: "2026-10-30T00:00:00.000Z", warnings: [], models: [legacy], providers: workersAi });
    let supportedEfforts: string[] | null = ["low", "high", "max"];
    const row = () => ({ id: "catalogue-uuid", name: "@cf/zai-org/glm-5.3-flash", task: { name: "Text Generation" },
      properties: [{ property_id: "context_window", value: "1048576" },
        ...(supportedEfforts === null ? [] : [{ property_id: "reasoning_effort", value: { supported_efforts: supportedEfforts } }])] }) as never;
    const aiModels = vi.fn(async () => [row()]);
    const env = fixtureEnv(bucket.binding, { providers: workersAi, gatewayId: null, aiModels });
    catalogues([], []);

    const storedRead = await readModelCatalog(env);
    expect(storedRead.models.find((model) => model.route === route)?.nativeReasoningEffort).toBe("low");
    expect(aiModels).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();

    const advertised = await refreshModelCatalog(env);
    expect(advertised.models.find((model) => model.route === route)?.nativeReasoningEffort).toBe("high");
    const persistedHigh = (bucket.stored() as { models: Array<{ route: string; nativeReasoningEffort?: string }> }).models
      .find((model) => model.route === route);
    expect(persistedHigh?.nativeReasoningEffort).toBe("high");

    supportedEfforts = ["low", "max"];
    const unsupported = await refreshModelCatalog(env);
    expect(unsupported.models.find((model) => model.route === route)).not.toHaveProperty("nativeReasoningEffort");
    const persistedUnsupported = (bucket.stored() as { models: Array<{ route: string; nativeReasoningEffort?: string }> }).models
      .find((model) => model.route === route);
    expect(persistedUnsupported).not.toHaveProperty("nativeReasoningEffort");
    expect(aiModels).toHaveBeenCalledTimes(2);
  });

  it("reports a missing snapshot visibly without discovery", async () => {
    const bucket = fakeBucket(null);
    const env = fixtureEnv(bucket.binding);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("discovery must not run on read"); }));
    const read = await readModelCatalog(env);
    expect(read.snapshot.updatedAt).toBeNull();
    expect(read.snapshot.refreshNeeded).toBe(true);
    expect(read.warnings.join(" ").toLowerCase()).toContain("refresh");
    expect(read.models.some((m) => m.route === "workers-ai:@cf/zai-org/glm-5.3-flash")).toBe(true);
  });

  it("reports a corrupt snapshot visibly and refuses to overwrite it on refresh", async () => {
    const bucket = fakeBucket({ bogus: true });
    const env = fixtureEnv(bucket.binding);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("discovery must not run on read"); }));
    const read = await readModelCatalog(env);
    expect(read.snapshot.refreshNeeded).toBe(true);
    expect(read.warnings.join(" ").toLowerCase()).toContain("could not be read");
    await expect(refreshModelCatalog(env)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("serves reads and admission from storage only without network", async () => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    catalogues(
      [{ id: "stored/cc-model", supported_endpoints: ["/chat/completions"], pricing: { prompt: "0.000001", completion: "0.000002" } }],
      [{ id: "stored/or-model", context_length: 64000, architecture: textChat, pricing: { prompt: "0.000001", completion: "0.000002" } }],
    );
    const refreshed = await refreshModelCatalog(env);
    const unknownRoute = "gateway:command-code/stored/cc-model";
    const knownRoute = "gateway:openrouter/stored/or-model";
    expect(refreshed.models.some((m) => m.route === unknownRoute)).toBe(true);
    expect(refreshed.models.find((m) => m.route === unknownRoute)?.contextTokens).toBeNull();
    expect(refreshed.models.find((m) => m.route === knownRoute)?.contextTokens).toBe(64000);
    expect(refreshed.models.every((m) => !("inputMicrousdPerMillion" in m) && !("cachedMicrousdPerMillion" in m) && !("outputMicrousdPerMillion" in m))).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("read must stay storage-only"); }));
    const read = await readModelCatalog(env);
    expect(read).toEqual(refreshed);
    const admitted = await requireAvailableModel(env, knownRoute);
    expect(admitted.route).toBe(knownRoute);
    await expect(requireAvailableModel(env, unknownRoute)).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("honors disabled providers by retaining the slice but marking it unavailable", async () => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    catalogues(
      [{ id: "kept/cc-model", context_length: 64000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "kept/or-model", context_length: 64000, architecture: textChat }],
    );
    await refreshModelCatalog(env);
    const disabled = defaultProviders().map((p) => p.id === "command-code" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: p.baseUrl, enabled: false } : p);
    const envDisabled = fixtureEnv(bucket.binding, { providers: disabled });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === OR) return Response.json({ data: [{ id: "kept/or-model", context_length: 64000, architecture: textChat }] });
      throw new Error("disabled provider must not be fetched: " + String(input));
    }));
    const refreshed = await refreshModelCatalog(envDisabled);
    const read = await readModelCatalog(envDisabled);
    void refreshed;
    const cc = read.models.filter((m) => m.route.indexOf("gateway:command-code/") === 0);
    expect(cc.length).toBeGreaterThan(0);
    expect(cc.every((m) => m.enabled === false && m.unavailableReason === "Provider is disabled.")).toBe(true);
  });

  it("skips native discovery when workers-ai is disabled without calling the binding", async () => {
    const bucket = fakeBucket();
    const modelsSpy = vi.fn(async () => []);
    const disabled = defaultProviders().map((p) => p.id === "workers-ai" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: p.baseUrl, enabled: false } : p);
    const env = fixtureEnv(bucket.binding, { providers: disabled, aiModels: modelsSpy });
    catalogues([], [{ id: "only-or/model", context_length: 64000, architecture: textChat }]);
    await refreshModelCatalog(env);
    expect(modelsSpy).not.toHaveBeenCalled();
    const read = await readModelCatalog(env);
    const native = read.models.filter((m) => m.route.indexOf("workers-ai:") === 0);
    expect(native.every((m) => m.enabled === false && m.unavailableReason === "Provider is disabled.")).toBe(true);
  });

  it.each([
    { field: "baseUrl", value: "https://api.commandcode.ai/provider/v2" },
    { field: "gatewaySlug", value: "renamed-command-code" },
    { field: "gatewayPath", value: "v2" },
    { field: "modelsUrl", value: "https://api.commandcode.ai/provider/v2/models" },
    { field: "metadataUrl", value: "https://models.dev/api.json" },
  ])("invalidates stored models when the same provider id changes $field until explicit refresh", async ({ field, value }) => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    catalogues(
      [{ id: "pinned/cc-model", context_length: 64000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "pinned/or-model", context_length: 64000, architecture: textChat }],
    );
    await refreshModelCatalog(env);
    const edited = defaultProviders().map((p) => {
      if (p.id !== "command-code") return p;
      const next = { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: p.baseUrl, enabled: p.enabled };
      (next as unknown as Record<string, unknown>)[field] = value;
      return next;
    });
    const envEdited = fixtureEnv(bucket.binding, { providers: edited });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("invalidation must not discover"); }));
    const read = await readModelCatalog(envEdited);
    const cc = read.models.filter((m) => m.route.indexOf("gateway:command-code/") === 0);
    expect(cc.length).toBeGreaterThan(0);
    expect(cc.every((m) => m.enabled === false && m.unavailableReason === "Refresh models after editing provider settings.")).toBe(true);
    expect(read.snapshot.refreshNeeded).toBe(false);
  });

  it("restores availability with an explicit refresh against the edited endpoint", async () => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    catalogues(
      [{ id: "edited/cc-model", context_length: 64000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "edited/or-model", context_length: 64000, architecture: textChat }],
    );
    await refreshModelCatalog(env);
    const editedBase = "https://api.commandcode.ai/provider/v2";
    const edited = defaultProviders().map((p) => p.id === "command-code" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: editedBase, enabled: true } : p);
    const envEdited = fixtureEnv(bucket.binding, { providers: edited });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === editedBase + "/models") return Response.json({ data: [{ id: "edited/cc-model", context_length: 64000, supported_endpoints: ["/chat/completions"] }] });
      if (url === OR) return Response.json({ data: [{ id: "edited/or-model", context_length: 64000, architecture: textChat }] });
      throw new Error("Unexpected metadata endpoint: " + url);
    });
    vi.stubGlobal("fetch", fetcher);
    const refreshed = await refreshModelCatalog(envEdited);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const cc = refreshed.models.filter((m) => m.route.indexOf("gateway:command-code/") === 0);
    expect(cc.some((m) => m.enabled)).toBe(true);
  });
});

describe("explicit anonymous providers", () => {
  const provider: ModelProvider = { id: "fixture", type: "openai-compatible", baseUrl: "https://api.example.com/v1",
    gatewaySlug: "custom-fixture", gatewayPath: "", enabled: true };
  it("keeps absent mode Gateway, compares effective mode, and freezes anonymous admission with a null Gateway ID and no AI", async () => {
    const route = "gateway:fixture/opaque";
    const bucket = fakeBucket({ updatedAt: "2026-11-09T00:00:00Z", warnings: [], providers: [provider], models: [
      { route, id: "opaque", label: "Opaque", contextTokens: 64000, maxOutputTokens: 8192, outputReserveTokens: 8192, checkedOn: "2026-11-09", enabled: true },
    ] });
    const env = fixtureEnv(bucket.binding, { providers: [provider] });
    const network = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("omit");
      return Response.json({ data: [{ id: "opaque", context_length: 64000, max_output_tokens: 8192, pricing: { prompt: "9" } }] });
    });
    vi.stubGlobal("fetch", network);
    const old = await requireAvailableModel(env, route);
    expect(old.routing?.provider).not.toHaveProperty("authMode");
    await saveModelProviders(env, [{ ...provider, authMode: "gateway" }]);
    expect((await requireAvailableModel(env, route)).route).toBe(route);
    expect(network).not.toHaveBeenCalled();
    await saveModelProviders(env, [{ ...provider, authMode: "anonymous", gatewaySlug: null }]);
    await expect(requireAvailableModel(env, route)).rejects.toMatchObject({ status: 503 });
    Reflect.deleteProperty(env, "AI");
    await refreshModelCatalog(env);
    const admitted = await requireAvailableModel(env, route);
    expect(admitted.routing).toMatchObject({ gatewayId: null, provider: { authMode: "anonymous", gatewaySlug: null } });
    expect(old.routing?.gatewayId).toBe("fixture-gateway"); expect(old.routing?.provider).not.toHaveProperty("authMode");
    await expect(resolveModelTransport({ DB: env.DB }, old, "frozen-gateway")).rejects.toMatchObject({ status: 503 });
    expect(network).toHaveBeenCalledTimes(1);
    expect((await readModelCatalog(env)).quotas).toEqual([{ providerId: "fixture", usage: null, limit: null, error: "quota-unknown" }]);
    expect(modelProviderSchema.safeParse({ ...provider, authMode: "anonymous", keyAlias: "named" }).success).toBe(false);
    expect(modelProviderSchema.safeParse({ ...defaultProviders()[0], authMode: "gateway" }).success).toBe(false);
  });
  it.each([401, 403])("does not use Gateway credentials after anonymous metadata HTTP %s", async status => {
    const network = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status })); vi.stubGlobal("fetch", network);
    const fetch = vi.fn().mockRejectedValue(new Error("No anonymous credential fallback"));
    const selected: ModelProvider = { ...provider, baseUrl: "https://openrouter.ai/api/v1", gatewaySlug: "openrouter", gatewayPath: "v1", authMode: "anonymous" };
    expect(await discoverGatewayModels([selected], undefined, { id: "fixture", ai: { fetch } })).toEqual([]);
    expect(network).toHaveBeenCalledTimes(1); expect(network.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/models");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["https://127.0.0.1/v1", "https://localhost/v1", "https://api.internal/v1"])("rejects private anonymous roots despite a public catalogue: %s", async baseUrl => {
    const selected: ModelProvider = { ...provider, baseUrl, modelsUrl: "https://catalogue.example.com/models", authMode: "anonymous" };
    expect(modelProviderSchema.safeParse(selected).success).toBe(false);
    const network = vi.fn().mockRejectedValue(new Error("No private egress")); vi.stubGlobal("fetch", network);
    expect(await discoverGatewayModels([selected])).toEqual([]); expect(network).not.toHaveBeenCalled();
  });
});

describe("Gateway BYOK alias configuration", () => {
  it("roundtrips nonsecret aliases and rejects unusable headers and native aliases", async () => {
    const providers = defaultProviders(), env = fixtureEnv(fakeBucket().binding);
    const provider = providers.find(p => p.id === "openrouter");
    const native = providers.find(p => p.type === "workers-ai");
    if (!provider || !native) throw new Error("Provider fixture missing.");
    const network = vi.fn().mockRejectedValue(new Error("Saving must not discover or infer"));
    vi.stubGlobal("fetch", network);
    for (const keyAlias of ["named.fixture:1", "a".repeat(300)]) {
      await saveModelProviders(env, [{ ...provider, keyAlias }]);
      expect(await getModelProviders(env)).toEqual([{ ...provider, keyAlias }]);
    }
    for (const keyAlias of ["", " alias", "alias ", "a\rb", "a\nb", "a\tb", "\u0000", "\u007f", "\u0085", "🧪"])
      expect(modelProviderSchema.safeParse({ ...provider, keyAlias }).success).toBe(false);
    expect(modelProviderSchema.safeParse({ ...native, keyAlias: "named" }).success).toBe(false);
    await saveModelProviders(env, [provider]);
    expect((await getModelProviders(env))[0]).not.toHaveProperty("keyAlias");
    await expect(resolveModelTransport({ AI: {} as Env["AI"], DB: env.DB },
      { ...MODELS[0], routing: { provider: { ...native, keyAlias: "named" }, gatewayId: "fixture" } } as ModelSpec, "native"))
      .rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(network).not.toHaveBeenCalled();
  });

  it("invalidates only the changed route and quota until Refresh, while admitted aliases stay frozen", async () => {
    const providers = defaultProviders().filter(p => p.type !== "workers-ai").map(p => p.id === "openrouter" ? { ...p, keyAlias: "before" } : p);
    const route = "gateway:openrouter/cached", other = "gateway:command-code/cached";
    const bucket = fakeBucket({ updatedAt: "2026-11-09T00:00:00Z", warnings: [], providers, quotaGatewayId: "fixture-gateway",
      quotas: providers.map(p => ({ providerId: p.id, usage: 1, limit: 10, error: null })),
      models: [route, other].map(route => ({ route, id: "cached", label: "Cached", contextTokens: 64000,
        maxOutputTokens: 8192, checkedOn: "2026-11-09", enabled: true })) });
    const env = fixtureEnv(bucket.binding, { providers });
    const admitted = await requireAvailableModel(env, route);
    const network = vi.fn(async () => Response.json({ data: [{ id: "cached", context_length: 64000 }] }));
    vi.stubGlobal("fetch", network);
    const snapshot = JSON.stringify(bucket.stored());
    await saveModelProviders(env, providers.map(p => p.id === "openrouter" ? { ...p, keyAlias: "after" } : p));
    const changed = await readModelCatalog(env);
    expect(changed.models.find(m => m.route === route)).toMatchObject({ enabled: false, unavailableReason: expect.stringContaining("Refresh") });
    expect(changed.models.find(m => m.route === other)?.enabled).toBe(true);
    expect(changed.quotas.find(q => q.providerId === "openrouter")).toMatchObject({ usage: null, limit: null });
    expect(changed.quotas.find(q => q.providerId === "command-code")).toMatchObject({ usage: 1, limit: 10 });
    await expect(requireAvailableModel(env, route)).rejects.toMatchObject({ status: 503 });
    expect(JSON.stringify(bucket.stored())).toBe(snapshot); expect(network).not.toHaveBeenCalled();
    const gateway = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("cf-aig-byok-alias")).toBe("after");
      return Response.json(String(url).endsWith("/key") ? { data: { usage: 2, limit: 10 } }
        : { data: [{ id: "cached", context_length: 64000, architecture: textChat }] });
    });
    Object.assign(env.AI, { fetch: gateway });
    await refreshModelCatalog(env);
    const refreshed = await requireAvailableModel(env, route);
    expect(refreshed.routing?.provider.keyAlias).toBe("after");
    expect(admitted.routing?.provider.keyAlias).toBe("before");
    expect((bucket.stored() as { providers: ModelProvider[] }).providers.find(p => p.id === "openrouter")?.keyAlias).toBe("after");
    const sent = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 403 }));
    const dispatchEnv = { AI: { fetch: sent } as unknown as Env["AI"], DB: env.DB };
    for (const model of [admitted, refreshed]) {
      const transport = await resolveModelTransport(dispatchEnv, model, "distill-attempt-fixture");
      await expect(generateText({ model: transport, prompt: "offline", maxRetries: 0 })).rejects.toThrow();
    }
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls.map(([, init]) => new Headers(init?.headers).get("cf-aig-byok-alias"))).toEqual(["before", "after"]);
  });

  it.each([401, 403].flatMap(publicStatus => [200, 400, 401, 403].map(gatewayStatus => ({ publicStatus, gatewayStatus }))))(
    "retries public $publicStatus once through the selected alias; Gateway $gatewayStatus", async ({ publicStatus, gatewayStatus }) => {
    const provider: ModelProvider = { id: "go", type: "openai-compatible", baseUrl: "https://opencode.ai/inference/go",
      modelsUrl: "https://opencode.ai/inference/go/v1/models", gatewaySlug: "custom-opencode-go", gatewayPath: "", enabled: true, keyAlias: "named" };
    const network = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: publicStatus }));
    vi.stubGlobal("fetch", network);
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => gatewayStatus === 200
      ? Response.json({ data: [{ id: "cached", context_length: 64000 }] }) : new Response(null, { status: gatewayStatus }));
    const errors: string[] = [];
    const models = await discoverGatewayModels([provider], (_id, reason) => errors.push(reason), { id: "fixture", ai: { fetch } });
    expect(models).toHaveLength(gatewayStatus === 200 ? 1 : 0);
    expect(fetch).toHaveBeenCalledTimes(1); expect(network).toHaveBeenCalledTimes(1);
    expect(String(network.mock.calls[0]?.[0])).toBe(provider.modelsUrl);
    const publicHeaders = new Headers(network.mock.calls[0]?.[1]?.headers);
    expect(publicHeaders.has("cf-aig-byok-alias")).toBe(false); expect(publicHeaders.has("x-opencode-session")).toBe(false);
    const request = fetch.mock.calls[0];
    if (!request) throw new Error("Gateway catalogue request missing.");
    expect(String(request[0])).toBe("https://workers-binding.ai/ai-gateway/gateways/fixture/custom-opencode-go/v1/models");
    const headers = new Headers(request[1]?.headers);
    expect(headers.get("cf-aig-byok-alias")).toBe("named");
    expect(headers.has("x-opencode-session")).toBe(false); expect(headers.has("authorization")).toBe(false);
    expect(errors).toEqual(gatewayStatus === 200 ? [] : [expect.stringContaining("HTTP " + gatewayStatus)]);
  });

  it.each([200, 400])("keeps ordinary public HTTP %s off Gateway despite an alias", async status => {
    const provider: ModelProvider = { id: "go", type: "openai-compatible", baseUrl: "https://opencode.ai/inference/go",
      modelsUrl: "https://opencode.ai/inference/go/v1/models", gatewaySlug: "custom-opencode-go", gatewayPath: "", enabled: true, keyAlias: "named" };
    const network = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => status === 200
      ? Response.json({ data: [{ id: "cached", context_length: 64000 }] }) : new Response(null, { status }));
    vi.stubGlobal("fetch", network);
    const fetch = vi.fn().mockRejectedValue(new Error("No Gateway call on public success or HTTP 400"));
    expect(await discoverGatewayModels([provider], undefined, { id: "fixture", ai: { fetch } })).toHaveLength(status === 200 ? 1 : 0);
    expect(network).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
    const headers = new Headers(network.mock.calls[0]?.[1]?.headers);
    expect(headers.has("cf-aig-byok-alias")).toBe(false); expect(headers.has("authorization")).toBe(false);
  });

  it.each(["https://catalogue.example.com/models", "https://opencode.ai/other/models"])("does not retry authentication outside the existing origin/path guard: %s", async modelsUrl => {
    const provider: ModelProvider = { id: "go", type: "openai-compatible", baseUrl: "https://opencode.ai/inference/go", modelsUrl,
      gatewaySlug: "custom-opencode-go", gatewayPath: "", enabled: true, keyAlias: "named" };
    const network = vi.fn(async () => new Response(null, { status: 403 })); vi.stubGlobal("fetch", network);
    const fetch = vi.fn().mockRejectedValue(new Error("Gateway boundary must remain narrow"));
    expect(await discoverGatewayModels([provider], undefined, { id: "fixture", ai: { fetch } })).toEqual([]);
    expect(network).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps aliases and conversation IDs off public catalogues and external metadata", async () => {
    const provider: ModelProvider = { id: "go", type: "openai-compatible", baseUrl: "https://opencode.ai/inference/go",
      gatewaySlug: "custom-opencode-go", gatewayPath: "", enabled: true, keyAlias: "named" };
    const publicFetch = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => Response.json(String(url) === "https://models.dev/api.json"
      ? { go: { models: {} } } : { data: [{ id: "cached", context_length: 64000 }] }));
    vi.stubGlobal("fetch", publicFetch);
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: [{ id: "cached", context_length: 64000 }] }));
    const gateway = { id: "fixture", ai: { fetch } };
    expect(await discoverGatewayModels([{ ...provider, modelsUrl: "https://catalogue.example.com/models" }], undefined, gateway)).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(await discoverGatewayModels([{ ...provider, metadataUrl: "https://models.dev/api.json" }], undefined, gateway)).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled(); expect(publicFetch).toHaveBeenCalledTimes(3);
    for (const [, init] of publicFetch.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.has("cf-aig-byok-alias")).toBe(false); expect(headers.has("x-opencode-session")).toBe(false);
    }
  });
});
