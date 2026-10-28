import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { availableModels, DEFAULT_MODEL, MODELS, modelOutputLimit, modelTokenLimit, readModelCatalog, refreshModelCatalog, requireAvailableModel, requireCatalogModel } from "./models";
import type { CatalogModel, ModelProvider } from "./models";
import type * as ModelCatalogModule from "./model-catalog";

vi.mock("./model-catalog", () => ({ discoverGatewayModels: vi.fn() }));
import { discoverGatewayModels } from "./model-catalog";
vi.mock("./native-model-catalog", () => ({ discoverNativeModels: vi.fn() }));
import { discoverNativeModels } from "./native-model-catalog";
const discoverNative = vi.mocked(discoverNativeModels);
const discover = vi.mocked(discoverGatewayModels);

// D1 settings fixture uses the actual migration 0008 provider JSON contract.
const fixtureProviders: ModelProvider[] = [
  { id: "workers-ai", type: "workers-ai", gatewaySlug: null, gatewayPath: "", baseUrl: null, enabled: true },
  { id: "openrouter", type: "openai-compatible", gatewaySlug: "openrouter", gatewayPath: "v1", baseUrl: "https://openrouter.ai/api/v1", enabled: true },
  { id: "command-code", type: "openai-compatible", gatewaySlug: "custom-command-code", gatewayPath: "v1", baseUrl: "https://api.commandcode.ai/provider/v1", enabled: true },
];

function fakeBucket(initial: unknown | null) {
  let stored = initial;
  const get = vi.fn(async (key: string) => {
    if (key !== "catalog/models.json" || stored === null) return null;
    const json = JSON.stringify(stored);
    return { size: new TextEncoder().encode(json).byteLength, json: async <T>() => JSON.parse(json) as T };
  });
  const put = vi.fn(async (key: string, value: unknown, _options?: unknown) => {
    if (key === "catalog/models.json") stored = JSON.parse(String(value));
    return {};
  });
  return { binding: { get, put } as unknown as R2Bucket, get, put, stored: () => stored };
}

let seededModels: CatalogModel[] = [];
function localConnection(gatewayId: string | null, models: CatalogModel[] | null = seededModels, providers: ModelProvider[] = fixtureProviders) {
  const prepare = vi.fn((sql: string) => ({
    first: vi.fn(async () => sql.includes("model_providers_json") ? { providers: JSON.stringify(providers) } : { gatewayId }),
    bind: vi.fn(() => ({ run: vi.fn(async () => ({})) })),
  }));
  const bucket = fakeBucket(models === null ? null : {
    updatedAt: "2026-10-28T00:00:00.000Z", warnings: [], models, providers,
  });
  const env: Pick<Env, "DB" | "BUCKET"> = { DB: { prepare } as unknown as Env["DB"], BUCKET: bucket.binding };
  return { env, prepare, bucket };
}

function nativeConnection(gatewayId: string | null, models: CatalogModel[] | null = seededModels, providers: ModelProvider[] = fixtureProviders) {
  const local = localConnection(gatewayId, models, providers);
  return { ...local, env: { ...local.env, AI: {} as Env["AI"] } };
}

function flashCatalogueModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  const seed = MODELS[0];
  if (!seed) throw new Error("The native fallback is missing.");
  const fallback = { ...seed };
  return { ...fallback, ...overrides };
}
let model: CatalogModel;
beforeEach(() => {
  vi.clearAllMocks();
  const id = "test-provider/model-" + crypto.randomUUID();
  model = { route: "gateway:command-code/" + id, id, label: "Discovered provider model", enabled: true,
    contextTokens: 1_048_576, maxOutputTokens: null, outputReserveTokens: 8192,
    responseFormat: false, structuredOutputs: false, checkedOn: "2026-10-27" };
  discover.mockResolvedValue([model]);
  discoverNative.mockResolvedValue([]);
  seededModels = [model];
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("Command Code catalogue model admission", () => {
  it("reads and admits a snapshot model without external calls or adding it to the native fallback list", async () => {
    const local = localConnection("fixture-gateway");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(MODELS.some((fallback) => fallback.route === model.route)).toBe(false);
    expect(await availableModels(local.env)).toEqual(expect.arrayContaining([expect.objectContaining(model)]));
    expect(await requireAvailableModel(local.env, model.route)).toEqual({ ...model,
      routing: { provider: fixtureProviders.find((provider) => provider.id === 'command-code'), gatewayId: 'fixture-gateway' } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(discoverNative).not.toHaveBeenCalled();
    expect(MODELS.some((fallback) => fallback.route === model.route)).toBe(false);
  });

  it("writes refreshed provider catalogue to R2 without selected routes or enrichment", async () => {
    const local = nativeConnection("fixture-gateway", null);
    const other: CatalogModel = { ...model, route: "gateway:command-code/other/model", id: "other/model", label: "Other" };
    discover.mockResolvedValue([model, other]);
    discoverNative.mockResolvedValue([]);

    const refreshed = await refreshModelCatalog(local.env);

    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledWith(fixtureProviders, expect.any(Function));
    expect(discoverNative).toHaveBeenCalledTimes(1);
    expect(local.bucket.put).toHaveBeenCalledTimes(1);
    expect(local.bucket.put.mock.calls[0]?.[0]).toBe("catalog/models.json");
    expect(local.bucket.stored()).toMatchObject({
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      warnings: [],
      models: expect.arrayContaining([
        expect.objectContaining({ route: model.route, contextTokens: model.contextTokens }),
        expect.objectContaining({ route: other.route, contextTokens: other.contextTokens }),
      ]),
      providers: expect.arrayContaining([
        expect.objectContaining({ id: "command-code", type: "openai-compatible" }),
        expect.objectContaining({ id: "workers-ai", type: "workers-ai" }),
      ]),
    });
    expect(local.bucket.stored()).not.toHaveProperty("gatewayId");
    expect(refreshed.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: model.route }),
      expect.objectContaining({ route: other.route }),
    ]));
    expect(refreshed.warnings).toEqual([]);
    expect(refreshed.snapshot.refreshNeeded).toBe(false);
  });

  it("keeps nullable provider capacity separate from the positive job output bound", async () => {
    const resolved = await requireAvailableModel(localConnection("fixture-gateway").env, model.route);
    expect(resolved.maxOutputTokens).toBeNull();
    expect(modelOutputLimit(resolved)).toBe(8192);
    expect(modelOutputLimit({ maxOutputTokens: null })).toBe(0);
    expect(modelOutputLimit({ maxOutputTokens: 4096, outputReserveTokens: 8192 })).toBe(4096);
  });

  it("keeps Flash usable without a Gateway or external discovery", async () => {
    const local = localConnection(null, []);
    expect(await requireAvailableModel(local.env, DEFAULT_MODEL)).toMatchObject({
      route: "workers-ai:@cf/zai-org/glm-5.3-flash", enabled: true, contextTokens: 1_048_576,
      maxOutputTokens: null, outputReserveTokens: 8192,
    });
    expect(local.prepare).toHaveBeenCalledTimes(2);
    expect(discover).not.toHaveBeenCalled();
    expect(discoverNative).not.toHaveBeenCalled();
  });

  it("exposes the per-call token bound without currency conversion", async () => {
    const resolved = await requireAvailableModel(localConnection("fixture-gateway").env, model.route);
    expect(modelTokenLimit(resolved)).toBe(resolved.contextTokens + modelOutputLimit(resolved));
    expect(modelTokenLimit(resolved)).toBe(1_048_576 + 8192);
  });

  describe("native Flash fallback", () => {
    it("uses live native context for Flash without external catalogue discovery", async () => {
      const live = flashCatalogueModel({ contextTokens: 64_000 });
      const local = nativeConnection(null, [live]);
      const admitted = await requireAvailableModel(local.env, DEFAULT_MODEL);
      expect(admitted).toMatchObject({ route: DEFAULT_MODEL, contextTokens: 64_000 });
      expect(modelTokenLimit(admitted)).toBe(64_000 + modelOutputLimit(admitted));
      expect(discoverNative).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
    });

    it.each([
      ["not published", false],
      ["published", true],
    ] as const)("uses low reasoning effort only when %s", async (_label, published) => {
      const live = flashCatalogueModel(published ? { nativeReasoningEffort: "low" } : {});
      const local = nativeConnection(null, [live]);
      const admitted = await requireAvailableModel(local.env, DEFAULT_MODEL);
      if (published) expect(admitted.nativeReasoningEffort).toBe("low");
      else expect(admitted).not.toHaveProperty("nativeReasoningEffort");
      expect(MODELS[0]).not.toHaveProperty("nativeReasoningEffort");
      expect(discover).not.toHaveBeenCalled();
      expect(discoverNative).not.toHaveBeenCalled();
    });

    it("retains the explicit Flash fallback when no snapshot exists", async () => {
      const local = nativeConnection(null, null);
      await expect(requireAvailableModel(local.env, DEFAULT_MODEL)).resolves.toEqual(MODELS[0]);
      await expect(readModelCatalog(local.env)).resolves.toMatchObject({
        warnings: [expect.stringContaining("has not been refreshed")],
        snapshot: { updatedAt: null, refreshNeeded: true },
      });
      expect(discoverNative).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
    });
  });
  it("keeps disconnected models unavailable without a token bound", async () => {
    const local = localConnection(null);
    expect((await availableModels(local.env)).find((entry) => entry.route === model.route)).toMatchObject({
      ...model, enabled: false, unavailableReason: expect.any(String),
    });
    await expect(requireAvailableModel(local.env, model.route)).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("keeps unknown context selectable for metadata saves but rejects effect admission", async () => {
    const unknown = { ...model, contextTokens: null };
    const local = localConnection("fixture-gateway", [unknown]);
    expect((await availableModels(local.env)).find((entry) => entry.route === model.route)).toMatchObject({ contextTokens: null, enabled: true });
    expect(await requireCatalogModel(local.env, model.route)).toEqual(unknown);
    await expect(requireAvailableModel(local.env, model.route)).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("rejects an unknown output bound rather than treating an unpublished cap as unlimited", async () => {
    const unknown = { ...model };
    delete unknown.outputReserveTokens;
    const local = localConnection("fixture-gateway", [unknown]);
    expect(await requireCatalogModel(local.env, model.route)).toEqual(unknown);
    await expect(requireAvailableModel(local.env, model.route)).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("rejects absent or explicitly disabled catalogue entries", async () => {
    const local = localConnection("fixture-gateway", []);
    await expect(requireAvailableModel(local.env, "gateway:command-code/absent-" + crypto.randomUUID())).rejects.toMatchObject({ code: "unavailable", status: 503 });
    await expect(requireAvailableModel(localConnection("fixture-gateway", [{ ...model, enabled: false }]).env, model.route))
      .rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("uses the native fallback and requests explicit refresh when the snapshot is absent", async () => {
    const local = localConnection("fixture-gateway", null);
    const catalog = await readModelCatalog(local.env);
    expect(catalog.models.find((entry) => entry.route === DEFAULT_MODEL)?.enabled).toBe(true);
    expect(catalog.snapshot.refreshNeeded).toBe(true);
    expect(catalog.warnings).toEqual([expect.stringContaining("has not been refreshed")]);
    expect(discover).not.toHaveBeenCalled();
    expect(discoverNative).not.toHaveBeenCalled();
  });
});

describe("registry-driven bounded catalogue", () => {
  it("discovers configured providers without hardcoded endpoints and keeps generic models selectable", async () => {
    const actual = await vi.importActual<typeof ModelCatalogModule>("./model-catalog");
    const providers = [
      { id: "generic", type: "openai-compatible", baseUrl: "https://generic.example/v1/", gatewaySlug: "generic", gatewayPath: "", enabled: true },
      { id: "cc", type: "openai-compatible", baseUrl: "https://cc.example/api", gatewaySlug: "cc", gatewayPath: "", enabled: true },
      { id: "or", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", gatewaySlug: "openrouter", gatewayPath: "v1", enabled: true },
      { id: "failing", type: "openai-compatible", baseUrl: "https://failing.example/", gatewaySlug: "failing", gatewayPath: "", enabled: true },
      { id: "disabled", type: "openai-compatible", baseUrl: "https://disabled.example/", gatewaySlug: "disabled", gatewayPath: "", enabled: false },
      { id: "workers-ai", type: "workers-ai", baseUrl: null, gatewaySlug: null, gatewayPath: "", enabled: true },
    ];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://generic.example/v1/models") return Response.json({ data: [
        { id: "plain-model" },
        { id: "plain-model" },
        { id: "explicit-nontext", architecture: { input_modalities: ["image"], output_modalities: ["text"] } },
      ] });
      if (url === "https://cc.example/api/models") return Response.json({ data: [
        { id: "chat-model", name: "Chat", context_length: 128000, supported_endpoints: ["/chat/completions"] },
        { id: "nonchat", supported_endpoints: ["/embeddings"] },
      ] });
      if (url === "https://openrouter.ai/api/v1/models") return Response.json({ data: [
        { id: "or-model", context_length: 100000, architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          pricing: { prompt: "0.000001", completion: 0.000002 }, supported_parameters: ["response_format", "structured_outputs"],
          top_provider: { max_completion_tokens: 20000 } },
      ] });
      if (url === "https://failing.example/models") return new Response("private upstream body", { status: 503 });
      throw new Error("Unexpected endpoint " + url);
    });
    vi.stubGlobal("fetch", fetcher);
    const errors: Array<{ id: string; message: string }> = [];
    const models = await actual.discoverGatewayModels(providers as never, (id, message) => errors.push({ id, message }));
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
      "https://generic.example/v1/models",
      "https://cc.example/api/models",
      "https://openrouter.ai/api/v1/models",
      "https://failing.example/models",
    ]));
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("disabled.example");
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("workers-ai");
    const byRoute = new Map(models.map((m) => [m.route, m]));
    expect(byRoute.get("gateway:generic/plain-model")).toMatchObject({ id: "plain-model", enabled: true, contextTokens: null });
    expect(models.filter((m) => m.route === "gateway:generic/plain-model")).toHaveLength(1);
    expect(byRoute.get("gateway:generic/explicit-nontext")).toMatchObject({ enabled: false });
    expect(byRoute.get("gateway:cc/chat-model")).toMatchObject({ id: "chat-model", label: "Chat", contextTokens: 128000, enabled: true });
    expect(byRoute.get("gateway:cc/nonchat")).toMatchObject({ enabled: false });
    expect(byRoute.get("gateway:or/or-model")).toMatchObject({ contextTokens: 100000, maxOutputTokens: 20000,
      responseFormat: true, structuredOutputs: true, enabled: true });
    expect(errors).toEqual([{ id: "failing", message: expect.stringContaining("failing model catalogue") }]);
    expect(JSON.stringify(errors)).not.toContain("private upstream body");
  });
});
