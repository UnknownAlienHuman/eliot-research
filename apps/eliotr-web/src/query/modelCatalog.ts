import type { ResearchModelCatalogPage } from "@eliotr/owner-api-client";
import type { createServiceModelSettingsApi } from "@eliotr/owner-api-client";

export type ModelCatalogVisibility = Awaited<ReturnType<ReturnType<typeof createServiceModelSettingsApi>["readServiceModelProviderCatalogPreferences"]>>["visibility"];
export type ModelCatalogEntry = ResearchModelCatalogPage["models"][number];

export function modelCatalogEntryKey(model: Pick<ModelCatalogEntry, "provider_id" | "model_id">): string {
  return `${model.provider_id.length}:${model.provider_id}${model.model_id}`;
}

function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

export function isModelCatalogEntryVisible(visibility: ModelCatalogVisibility, modelId: string): boolean {
  switch (visibility.mode) {
    case "all": return true;
    case "none": return false;
    case "include": return visibility.model_ids.includes(modelId);
    case "exclude": return !visibility.model_ids.includes(modelId);
  }
}

/** Toggle presentation only; catalog/account inventory and provider authorization are unchanged. */
export function setModelCatalogEntryVisibility(
  visibility: ModelCatalogVisibility,
  modelId: string,
  visible: boolean,
): ModelCatalogVisibility {
  switch (visibility.mode) {
    case "all":
      return visible ? visibility : { mode: "exclude", model_ids: [modelId] };
    case "none":
      return visible ? { mode: "include", model_ids: [modelId] } : visibility;
    case "include": {
      const ids = new Set(visibility.model_ids);
      if (visible) ids.add(modelId); else ids.delete(modelId);
      const sorted = sortedIds([...ids]);
      return sorted.length === 0 ? { mode: "none" } : { mode: "include", model_ids: sorted };
    }
    case "exclude": {
      const ids = new Set(visibility.model_ids);
      if (visible) ids.delete(modelId); else ids.add(modelId);
      const sorted = sortedIds([...ids]);
      return sorted.length === 0 ? { mode: "all" } : { mode: "exclude", model_ids: sorted };
    }
  }
}

export function setAllModelCatalogEntriesVisible(visible: boolean): ModelCatalogVisibility {
  return visible ? { mode: "all" } : { mode: "none" };
}

export function filterModelCatalogEntries(
  models: readonly ModelCatalogEntry[],
  search: string,
): readonly ModelCatalogEntry[] {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return models;
  return models.filter(model => [model.provider_id, model.model_id, model.name, model.description, ...model.tags]
    .some(value => value.toLocaleLowerCase().includes(needle)));
}

export function visibleModelCatalogEntries(
  models: readonly ModelCatalogEntry[],
  visibility: ModelCatalogVisibility,
): readonly ModelCatalogEntry[] {
  return models.filter(model => isModelCatalogEntryVisible(visibility, model.model_id));
}
