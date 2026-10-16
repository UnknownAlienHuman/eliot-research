import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ read: vi.fn(), put: vi.fn() }));
vi.mock("@eliotr/cloudflare-model-control", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), createD1ResearchModelPricingSnapshotStore: () => ({ read: ports.read, putImmutable: ports.put }),
}));
import type { ResearchModelCatalogEntry, ResearchModelPricingSnapshot } from "@eliotr/cloudflare-model-control";
import { nativeBuiltinCatalogTokenRates, createResearchNativeBuiltinCatalogPricing,
  nativeBuiltinCatalogRequestCapabilities } from "./research-native-builtin-catalog-pricing.js";
import type { ResearchCatalogModelUseAuthorizationRow } from "./research-catalog-model-use-store.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
function model(prices: ResearchModelCatalogEntry["properties"][number]["value"] = [
  { unit: "per M input tokens", price: "0.293" }, { unit: "per M output tokens", price: "2.253" },
]): ResearchModelCatalogEntry {
  return { provider_id: "cloudflare-workers-ai", model_id: MODEL, name: "Native catalog fixture", description: "Controlled pricing observation",
    catalog_availability: "listed", account_availability: "unknown", source_id: 1,
    source_task: { id: "text-generation", name: "Text Generation", description: "Controlled native task" },
    capabilities: { text_generation: "supported", input_output_schema: "not_exposed_by_workers_ai_binding",
      schema_requirement: "GET /client/v4/accounts/{account_id}/ai/models/schema?model={model_id}" },
    billing: { selected_path: "workers_ai_binding", support: "unknown", account_entitlement: "not_established_by_catalog" },
    properties: [{ property_id: "price", value: prices }], tags: [] };
}
beforeEach(() => vi.resetAllMocks());

describe("native builtin catalog pricing observations", () => {
  it("converts explicitly denominated native token prices exactly, without inventing a free price", () => {
    expect(nativeBuiltinCatalogTokenRates(model())).toEqual({ input: "0.000293", output: "0.002253", cache_read: null });
    expect(nativeBuiltinCatalogTokenRates(model([{ unit: "per 1M input tokens", price: 0 },
      { unit: "per 1,000 output tokens", price: "0.00021", currency: "USD" }]))).toEqual({ input: "0", output: "0.00021", cache_read: null });
  });
  it("accepts the saved live GLM cached-input direction and metadata reasoning normalization", () => {
    const entry = model([{ unit: "per M input tokens", price: 0.15, currency: "USD" },
      { unit: "per M output tokens", price: 0.5, currency: "USD" }, { unit: "per M cached input tokens", price: 0.03, currency: "USD" }]);
    expect(nativeBuiltinCatalogTokenRates(entry)).toEqual({ input: "0.00015", output: "0.0005", cache_read: "0.00003" });
    const configured: ResearchModelCatalogEntry = { ...entry, properties: [...entry.properties, { property_id: "reasoning_effort", value: {
      supported_efforts: ["max", "high", "low"], default_effort: "max", mandatory: true, default_enabled: true,
      normalizes_to: { none: "max", minimal: "max", medium: "max", xhigh: "max", null: "max" },
    } }] };
    expect(nativeBuiltinCatalogRequestCapabilities(configured)).toEqual({ max_output_tokens_field: "max_tokens",
      reasoning_efforts: ["max", "high", "low"], reasoning_effort_normalizations: { medium: "max" } });
  });
  it.each(["generic-tokens", "neurons", "missing-output", "duplicate-direction", "currency", "negative", "extra-charge"])("rejects unproven pricing: %s", fault => {
    const prices: Record<string, string | number>[] = [{ unit: "per M input tokens", price: "0.293" }, { unit: "per M output tokens", price: "2.253" }];
    if (fault === "generic-tokens") Object.assign(prices[0] ?? {}, { unit: "tokens" });
    if (fault === "neurons") Object.assign(prices[0] ?? {}, { unit: "per neuron" });
    if (fault === "missing-output") prices.pop();
    if (fault === "duplicate-direction") Object.assign(prices[1] ?? {}, { unit: "per M input tokens" });
    if (fault === "currency") Object.assign(prices[0] ?? {}, { currency: "EUR" });
    if (fault === "negative") Object.assign(prices[0] ?? {}, { price: -1 });
    if (fault === "extra-charge") prices.push({ unit: "per image", price: "1" });
    expect(() => nativeBuiltinCatalogTokenRates(model(prices))).toThrowError(expect.objectContaining({ code: "PRICING_NOT_PROVEN" }));
  });
  it("binds exact prices to the real owner operation/model/routes and reuses immutable observations", async () => {
    const operation = { owner_id: "owner-1", project_id: "project-1", operation_id: "11111111-1111-4111-8111-111111111111",
      provider_id: "cloudflare-workers-ai", provider_operation_id: null, model_id: MODEL, state: "PREPARING" } as ResearchCatalogModelUseAuthorizationRow;
    let now = "2026-10-16T20:00:01.000Z";
    const saved = new Map<string, ResearchModelPricingSnapshot>();
    ports.read.mockImplementation(async identity => saved.get(identity.pricing_snapshot_ref) ?? null);
    ports.put.mockImplementation(async ({ snapshot }) => {
      const value = { ...snapshot, snapshot_sha256: "a".repeat(64), created_at: now };
      saved.set(snapshot.pricing_snapshot_ref, value);
      return value;
    });
    const service = createResearchNativeBuiltinCatalogPricing({ database: {} as D1Database, now: () => now,
      read_current_authority: async () => operation, read_advertised_model: async () => model() });
    const routes = [{ route_ref: "dynamic/eliotr-balanced", route_version: "native-operation-route" }];
    const first = await service.ensure(operation, routes, "2026-10-16T20:10:00.000Z");
    expect(first[0]).toMatchObject({ exact_model_id: MODEL, provider: "workers-ai", route_version: routes[0]?.route_version,
      input_rate_usd_per_1k_tokens: "0.000293", approval_receipt_ref: `catalog-model-use-${operation.operation_id}` });
    now = "2026-10-16T20:00:30.000Z";
    expect(await service.ensure(operation, routes, "2026-10-16T20:10:00.000Z")).toEqual(first);
    expect(ports.put).toHaveBeenCalledOnce();
    expect(first[0]?.effective_at).toBe("2026-10-16T20:00:01.000Z");
  });
  it("rejects owner authority changed during the native price read before any price write", async () => {
    const operation = { provider_id: "cloudflare-workers-ai", provider_operation_id: null,
      model_id: MODEL, state: "PREPARING" } as ResearchCatalogModelUseAuthorizationRow;
    let current = operation;
    const service = createResearchNativeBuiltinCatalogPricing({ database: {} as D1Database,
      now: () => "2026-10-16T20:00:01.000Z", read_current_authority: async () => current,
      read_advertised_model: async () => { current = { ...operation, state: "BLOCKED" }; return model(); } });
    await expect(service.ensure(operation, [{ route_ref: "dynamic/eliotr-balanced", route_version: "native-route" }],
      "2026-10-16T20:10:00.000Z")).rejects.toMatchObject({ code: "AUTHORITY_CHANGED" });
    expect(ports.put).not.toHaveBeenCalled();
  });
});
