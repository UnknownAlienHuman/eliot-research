import { beforeEach, describe, expect, it, vi } from "vitest";
import { estimateCost } from "./cost";
import { availableModels, DEFAULT_MODEL, MODELS, modelOutputLimit, requireAvailableModel, requireCatalogModel } from "./models";
import type { CatalogModel } from "./models";

vi.mock("./model-catalog", () => ({ discoverGatewayModels: vi.fn(), enrichSelectedModel: vi.fn(async (model: CatalogModel) => model) }));
import { discoverGatewayModels } from "./model-catalog";
vi.mock("./native-model-catalog", () => ({ discoverNativeModels: vi.fn() }));
import { discoverNativeModels } from "./native-model-catalog";
const discoverNative = vi.mocked(discoverNativeModels);
const discover = vi.mocked(discoverGatewayModels);

function localConnection(gatewayId: string | null) {
  const first = vi.fn(async () => ({ gatewayId }));
  const prepare = vi.fn(() => ({ first }));
  const env: Pick<Env, "DB"> = { DB: { prepare } as unknown as Env["DB"] };
  return { env, prepare };
}

function nativeConnection(gatewayId: string | null) {
  const local = localConnection(gatewayId);
  return { ...local, env: { ...local.env, AI: {} as Env["AI"] } };
}

function flashCatalogueModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  const seed = MODELS[0];
  if (!seed) throw new Error("The native fallback is missing.");
  const fallback = { ...seed };
  delete fallback.nativeReasoningEffort;
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
});

describe("Command Code catalogue model admission", () => {
  it("discovers an arbitrary provider model without adding it to the native fallback list", async () => {
    const local = localConnection("fixture-gateway");
    expect(MODELS.some((fallback) => fallback.route === model.route)).toBe(false);
    expect(await availableModels(local.env)).toEqual(expect.arrayContaining([expect.objectContaining(model)]));
    expect(await requireAvailableModel(local.env, model.route)).toEqual(model);
    expect(discover).toHaveBeenCalled();
    expect(MODELS.some((fallback) => fallback.route === model.route)).toBe(false);
  });

  it("keeps nullable provider capacity separate from the positive job output bound", async () => {
    const resolved = await requireAvailableModel(localConnection("fixture-gateway").env, model.route);
    expect(resolved.maxOutputTokens).toBeNull();
    expect(modelOutputLimit(resolved)).toBe(8192);
    expect(modelOutputLimit({ maxOutputTokens: null })).toBe(0);
    expect(modelOutputLimit({ maxOutputTokens: 4096, outputReserveTokens: 8192 })).toBe(4096);
  });

  it("keeps Flash usable without a Gateway or external discovery", async () => {
    const local = localConnection(null);
    discover.mockRejectedValue(new Error("Catalogue unavailable"));
    expect(await requireAvailableModel(local.env, DEFAULT_MODEL)).toMatchObject({
      route: "workers-ai:@cf/zai-org/glm-5.3-flash", enabled: true, contextTokens: 1_048_576,
      maxOutputTokens: null, outputReserveTokens: 8192,
      inputMicrousdPerMillion: 150000, cachedMicrousdPerMillion: 30000, outputMicrousdPerMillion: 500000,
    });
    expect(local.prepare).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  describe("native Flash fallback", () => {
    it("uses live native context and rates for Flash without external catalogue discovery", async () => {
      const local = nativeConnection(null);
      const live = flashCatalogueModel({
        contextTokens: 64_000,
        inputMicrousdPerMillion: 240_000,
        cachedMicrousdPerMillion: 20_000,
        outputMicrousdPerMillion: 900_000,
      });
      discoverNative.mockResolvedValue([live]);

      const admitted = await requireAvailableModel(local.env, DEFAULT_MODEL);

      expect(admitted).toMatchObject({
        route: DEFAULT_MODEL,
        contextTokens: 64_000,
        inputMicrousdPerMillion: 240_000,
        cachedMicrousdPerMillion: 20_000,
        outputMicrousdPerMillion: 900_000,
      });
      expect(discoverNative).toHaveBeenCalledWith(local.env.AI);
      expect(discover).not.toHaveBeenCalled();
    });

    it("keeps unknown live prices selectable but rejects paid admission", async () => {
      const local = nativeConnection(null);
      const unknown = flashCatalogueModel({
        inputMicrousdPerMillion: null,
        outputMicrousdPerMillion: null,
      });
      discoverNative.mockResolvedValue([unknown]);

      const listed = await availableModels(local.env);
      expect(listed.find((entry) => entry.route === DEFAULT_MODEL)).toMatchObject({
        enabled: true,
        inputMicrousdPerMillion: null,
        outputMicrousdPerMillion: null,
      });

      discover.mockClear();
      discoverNative.mockClear();
      await expect(requireCatalogModel(local.env, DEFAULT_MODEL)).resolves.toMatchObject({
        inputMicrousdPerMillion: null,
        outputMicrousdPerMillion: null,
      });
      await expect(requireAvailableModel(local.env, DEFAULT_MODEL)).rejects.toMatchObject({
        code: "unavailable",
        status: 503,
      });
      expect(discover).not.toHaveBeenCalled();
    });

    it.each([
      ["not published", false],
      ["published", true],
    ] as const)("uses low reasoning effort only when %s", async (_label, published) => {
      const local = nativeConnection(null);
      const live = flashCatalogueModel(published ? { nativeReasoningEffort: "low" } : {});
      discoverNative.mockResolvedValue([live]);

      const admitted = await requireAvailableModel(local.env, DEFAULT_MODEL);

      if (published) expect(admitted.nativeReasoningEffort).toBe("low");
      else expect(admitted).not.toHaveProperty("nativeReasoningEffort");
      expect(discover).not.toHaveBeenCalled();
    });

    it.each(["absent", "failed"] as const)("retains the explicit Flash fallback when native discovery is %s", async (state) => {
      const local = nativeConnection(null);
      if (state === "absent") discoverNative.mockResolvedValue([]);
      else discoverNative.mockRejectedValue(new Error("Native catalogue unavailable"));

      await expect(requireAvailableModel(local.env, DEFAULT_MODEL)).resolves.toEqual(MODELS[0]);
      expect(discoverNative).toHaveBeenCalledWith(local.env.AI);
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
      discover.mockResolvedValue([unknown]);
      const local = localConnection("fixture-gateway");
      expect((await availableModels(local.env)).find((entry) => entry.route === model.route)).toMatchObject({ [field]: null, enabled: true });
      expect(await requireCatalogModel(local.env, model.route)).toEqual(unknown);
      await expect(requireAvailableModel(local.env, model.route)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    });

  it("rejects an unknown output bound rather than treating an unpublished cap as unlimited", async () => {
    const unknown = { ...model };
    delete unknown.outputReserveTokens;
    discover.mockResolvedValue([unknown]);
    const local = localConnection("fixture-gateway");
    expect(await requireCatalogModel(local.env, model.route)).toEqual(unknown);
    await expect(requireAvailableModel(local.env, model.route)).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("resolves a unique discovered alias and preserves the exact selected route", async () => {
    const alias = "gateway:command-code/choice-" + crypto.randomUUID();
    discover.mockResolvedValue([{ ...model, aliases: [alias] }]);
    expect(await requireCatalogModel(localConnection("fixture-gateway").env, alias)).toMatchObject({ ...model, route: alias });
    expect(await requireAvailableModel(localConnection("fixture-gateway").env, alias)).toMatchObject({ ...model, route: alias });
  });

  it("rejects an ambiguous alias instead of selecting a provider model arbitrarily", async () => {
    const alias = "gateway:command-code/shared-choice";
    discover.mockResolvedValue([{ ...model, aliases: [alias] }, { ...model, id: "another/model", route: "gateway:command-code/another/model", aliases: [alias] }]);
    await expect(requireAvailableModel(localConnection("fixture-gateway").env, alias)).rejects.toThrow("ambiguous");
  });

  it("rejects absent or explicitly disabled catalogue entries", async () => {
    const local = localConnection("fixture-gateway");
    await expect(requireAvailableModel(local.env, "gateway:command-code/absent-" + crypto.randomUUID())).rejects.toMatchObject({ code: "unavailable", status: 503 });
    discover.mockResolvedValue([{ ...model, enabled: false }]);
    await expect(requireAvailableModel(local.env, model.route)).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("uses discovered prices and conservatively handles an unknown cache discount", async () => {
    const local = localConnection("fixture-gateway");
    const priced = await requireAvailableModel(local.env, model.route);
    expect(estimateCost(priced, priced.contextTokens, 0, modelOutputLimit(priced))).toBe(106496);
    expect(estimateCost(priced, 1_000_000, 500_000, 8192)).toBe(52639);
    discover.mockResolvedValue([{ ...model, cachedMicrousdPerMillion: null }]);
    const uncached = await requireAvailableModel(local.env, model.route);
    expect(uncached.cachedMicrousdPerMillion).toBeNull();
    expect(estimateCost(uncached, 1_000_000, 500_000, 8192)).toBe(101639);
  });

  it("retains the native fallback when external discovery fails", async () => {
    discover.mockRejectedValue(new Error("Provider catalogue failed"));
    const listed = await availableModels(localConnection("fixture-gateway").env);
    expect(listed.find((entry) => entry.route === DEFAULT_MODEL)?.enabled).toBe(true);
    expect(listed.some((entry) => entry.route === model.route)).toBe(false);
  });
});
