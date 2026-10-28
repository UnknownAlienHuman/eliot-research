import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateCost } from "./cost";
import { availableModels, DEFAULT_MODEL, MODELS, modelOutputLimit, readModelCatalog, refreshModelCatalog, requireAvailableModel, requireCatalogModel } from "./models";
import type { CatalogModel } from "./models";

vi.mock("./model-catalog", () => ({ discoverGatewayModels: vi.fn(), enrichSelectedModel: vi.fn(async (model: CatalogModel) => model) }));
import { discoverGatewayModels, enrichSelectedModel } from "./model-catalog";
vi.mock("./native-model-catalog", () => ({ discoverNativeModels: vi.fn() }));
import { discoverNativeModels } from "./native-model-catalog";
const discoverNative = vi.mocked(discoverNativeModels);
const discover = vi.mocked(discoverGatewayModels);
const enrich = vi.mocked(enrichSelectedModel);

function fakeBucket(initial: unknown | null) {
  let stored = initial;
  const get = vi.fn(async (key: string) => {
    if (key !== "catalog/models.json" || stored === null) return null;
    const json = JSON.stringify(stored);
    return { size: new TextEncoder().encode(json).byteLength, json: async <T>() => JSON.parse(json) as T };
  });
  const put = vi.fn(async (key: string, value: unknown) => {
    if (key === "catalog/models.json") stored = JSON.parse(String(value));
    return {};
  });
  return { binding: { get, put } as unknown as R2Bucket, get, put, stored: () => stored };
}

let seededModels: CatalogModel[] = [];
function localConnection(gatewayId: string | null, models: CatalogModel[] | null = seededModels) {
  const first = vi.fn(async () => ({ gatewayId }));
  const prepare = vi.fn(() => ({ first }));
  const bucket = fakeBucket(models === null ? null : {
    updatedAt: "2026-10-28T00:00:00.000Z", warnings: [], models,
  });
  const env: Pick<Env, "DB" | "BUCKET"> = { DB: { prepare } as unknown as Env["DB"], BUCKET: bucket.binding };
  return { env, prepare, bucket };
}

function nativeConnection(gatewayId: string | null, models: CatalogModel[] | null = seededModels) {
  const local = localConnection(gatewayId, models);
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
    responseFormat: false, structuredOutputs: false, inputMicrousdPerMillion: 100000,
    cachedMicrousdPerMillion: 2000, outputMicrousdPerMillion: 200000, checkedOn: "2026-10-27" };
  discover.mockResolvedValue([model]);
  discoverNative.mockResolvedValue([]);
  enrich.mockImplementation(async (candidate) => candidate);
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
    expect(await requireAvailableModel(local.env, model.route)).toEqual(model);
    expect(fetcher).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(discoverNative).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
    expect(MODELS.some((fallback) => fallback.route === model.route)).toBe(false);
  });

  it("writes refreshed metadata to R2 and enriches only an explicitly selected route", async () => {
    const local = localConnection("fixture-gateway", null);
    const other: CatalogModel = { ...model, route: "gateway:command-code/other/model", id: "other/model", label: "Other" };
    discover.mockResolvedValue([model, other]);
    enrich.mockImplementation(async (candidate) => candidate.route === model.route
      ? { ...candidate, inputMicrousdPerMillion: 234000 } : candidate);

    const refreshed = await refreshModelCatalog(local.env, [model.route]);

    expect(discover).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledWith(model);
    expect(local.bucket.put).toHaveBeenCalledTimes(1);
    expect(local.bucket.put.mock.calls[0]?.[0]).toBe("catalog/models.json");
    expect(local.bucket.stored()).toMatchObject({
      updatedAt: expect.stringMatching(/^2026-10-28T/),
      models: expect.arrayContaining([expect.objectContaining({ route: model.route, inputMicrousdPerMillion: 234000 })]),
    });
    expect(local.bucket.stored()).not.toHaveProperty("gatewayId");
    expect(refreshed.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: model.route, inputMicrousdPerMillion: 234000 }),
      expect.objectContaining({ route: other.route, inputMicrousdPerMillion: other.inputMicrousdPerMillion }),
    ]));
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
      inputMicrousdPerMillion: 150000, cachedMicrousdPerMillion: 30000, outputMicrousdPerMillion: 500000,
    });
    expect(local.prepare).toHaveBeenCalledTimes(1);
    expect(discover).not.toHaveBeenCalled();
    expect(discoverNative).not.toHaveBeenCalled();
  });

  describe("native Flash fallback", () => {
    it("uses live native context and rates for Flash without external catalogue discovery", async () => {
      const live = flashCatalogueModel({
        contextTokens: 64_000,
        inputMicrousdPerMillion: 240_000,
        cachedMicrousdPerMillion: 20_000,
        outputMicrousdPerMillion: 900_000,
      });
      const local = nativeConnection(null, [live]);
      const admitted = await requireAvailableModel(local.env, DEFAULT_MODEL);

      expect(admitted).toMatchObject({
        route: DEFAULT_MODEL,
        contextTokens: 64_000,
        inputMicrousdPerMillion: 240_000,
        cachedMicrousdPerMillion: 20_000,
        outputMicrousdPerMillion: 900_000,
      });
      expect(discoverNative).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
    });

    it("keeps unknown live prices selectable but rejects paid admission", async () => {
      const unknown = flashCatalogueModel({
        inputMicrousdPerMillion: null,
        outputMicrousdPerMillion: null,
      });
      const local = nativeConnection(null, [unknown]);
      const listed = await availableModels(local.env);
      expect(listed.find((entry) => entry.route === DEFAULT_MODEL)).toMatchObject({
        enabled: true,
        inputMicrousdPerMillion: null,
        outputMicrousdPerMillion: null,
      });

      discover.mockClear();
      await expect(requireCatalogModel(local.env, DEFAULT_MODEL)).resolves.toMatchObject({
        inputMicrousdPerMillion: null,
        outputMicrousdPerMillion: null,
      });
      await expect(requireAvailableModel(local.env, DEFAULT_MODEL)).rejects.toMatchObject({
        code: "unavailable",
        status: 503,
      });
      expect(discover).not.toHaveBeenCalled();
      expect(discoverNative).not.toHaveBeenCalled();
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
  it("lists disconnected discovered models without inventing zero prices", async () => {
    const local = localConnection(null);
    expect((await availableModels(local.env)).find((entry) => entry.route === model.route)).toMatchObject({
      ...model, enabled: false, unavailableReason: expect.any(String),
    });
    await expect(requireAvailableModel(local.env, model.route)).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it.each(["contextTokens", "inputMicrousdPerMillion", "outputMicrousdPerMillion"] as const)(
    "keeps unknown %s selectable for metadata saves but rejects effect admission", async (field) => {
      const unknown = { ...model, [field]: null };
      const local = localConnection("fixture-gateway", [unknown]);
      expect((await availableModels(local.env)).find((entry) => entry.route === model.route)).toMatchObject({ [field]: null, enabled: true });
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

  it("resolves a unique discovered alias and preserves the exact selected route", async () => {
    const alias = "gateway:command-code/choice-" + crypto.randomUUID();
    const aliased = { ...model, aliases: [alias] };
    expect(await requireCatalogModel(localConnection("fixture-gateway", [aliased]).env, alias)).toMatchObject({ ...model, aliases: [alias], route: alias });
    expect(await requireAvailableModel(localConnection("fixture-gateway", [aliased]).env, alias)).toMatchObject({ ...model, aliases: [alias], route: alias });
  });

  it("rejects an ambiguous alias instead of selecting a provider model arbitrarily", async () => {
    const alias = "gateway:command-code/shared-choice";
    const aliased = [{ ...model, aliases: [alias] }, { ...model, id: "another/model", route: "gateway:command-code/another/model", aliases: [alias] }];
    await expect(requireAvailableModel(localConnection("fixture-gateway", aliased).env, alias)).rejects.toThrow("ambiguous");
  });

  it("rejects absent or explicitly disabled catalogue entries", async () => {
    const local = localConnection("fixture-gateway", []);
    await expect(requireAvailableModel(local.env, "gateway:command-code/absent-" + crypto.randomUUID())).rejects.toMatchObject({ code: "unavailable", status: 503 });
    await expect(requireAvailableModel(localConnection("fixture-gateway", [{ ...model, enabled: false }]).env, model.route))
      .rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("uses discovered prices and conservatively handles an unknown cache discount", async () => {
    const local = localConnection("fixture-gateway");
    const priced = await requireAvailableModel(local.env, model.route);
    expect(estimateCost(priced, priced.contextTokens, 0, modelOutputLimit(priced))).toBe(106496);
    expect(estimateCost(priced, 1_000_000, 500_000, 8192)).toBe(52639);
    const uncached = await requireAvailableModel(localConnection("fixture-gateway", [{ ...model, cachedMicrousdPerMillion: null }]).env, model.route);
    expect(uncached.cachedMicrousdPerMillion).toBeNull();
    expect(estimateCost(uncached, 1_000_000, 500_000, 8192)).toBe(101639);
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
