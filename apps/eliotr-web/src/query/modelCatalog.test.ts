import { describe, expect, it } from "vitest";
import { filterModelCatalogEntries, isModelCatalogEntryVisible, setAllModelCatalogEntriesVisible,
  setModelCatalogEntryVisibility, visibleModelCatalogEntries, type ModelCatalogEntry } from "./modelCatalog";

const model = (providerId: string, modelId: string, name: string, tags: readonly string[] = []): ModelCatalogEntry => ({
  provider_id: providerId, model_id: modelId, name, description: "Text generation model.", catalog_availability: "listed",
  account_availability: "unverified", capabilities: { text_generation: "supported",
    input_output_schema: "available_from_transport", schema_requirement: null }, source_id: null, source_task: null,
  billing: { selected_path: "provider_catalog", support: "unknown", account_entitlement: "not_established_by_catalog" },
  properties: [], tags,
});

const catalog = [model("openai", "gpt-6.1", "Workhorse", ["chat"]),
  model("opencode-go", "step-5", "Reasoning", ["analysis"])] as const;

describe("model catalog visibility and filtering", () => {
  it("supports all, none, include, and exclude preferences without changing access facts", () => {
    const hidden = setModelCatalogEntryVisibility({ mode: "all" }, "gpt-6.1", false);
    expect(hidden).toEqual({ mode: "exclude", model_ids: ["gpt-6.1"] });
    expect(isModelCatalogEntryVisible(hidden, "gpt-6.1")).toBe(false);
    expect(isModelCatalogEntryVisible(hidden, "step-5")).toBe(true);
    expect(setModelCatalogEntryVisibility(hidden, "gpt-6.1", true)).toEqual({ mode: "all" });
    expect(setModelCatalogEntryVisibility({ mode: "none" }, "step-5", true))
      .toEqual({ mode: "include", model_ids: ["step-5"] });
    expect(setModelCatalogEntryVisibility({ mode: "include", model_ids: ["gpt-6.1"] }, "gpt-6.1", false))
      .toEqual({ mode: "none" });
    expect(setAllModelCatalogEntriesVisible(false)).toEqual({ mode: "none" });
  });

  it("filters catalog inventory by provider, model ID, name, description, or tag", () => {
    expect(filterModelCatalogEntries(catalog, "OPENCODE").map(entry => entry.model_id)).toEqual(["step-5"]);
    expect(filterModelCatalogEntries(catalog, "analysis").map(entry => entry.model_id)).toEqual(["step-5"]);
    expect(filterModelCatalogEntries(catalog, "gpt-6.1").map(entry => entry.model_id)).toEqual(["gpt-6.1"]);
    expect(visibleModelCatalogEntries(catalog, { mode: "none" })).toEqual([]);
    expect(catalog.every(entry => entry.catalog_availability === "listed" && entry.account_availability === "unverified")).toBe(true);
  });
});
