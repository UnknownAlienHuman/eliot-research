import type { CatalogModel } from "./models";

// Ai.models() from workers-types 5.20261024.1; runtime properties were checked
// against the real binding on 2026-10-27. Property values are untrusted metadata,
// including objects/arrays although that pinned type currently declares string.
type NativeRow = Awaited<ReturnType<Ai["models"]>>[number];
const PAGE_SIZE = 100, MAX_ROWS = 2000;
export function nativeModel(row: NativeRow, checkedOn: string): CatalogModel | null {
  if (row.task?.name !== "Text Generation" || typeof row.name !== "string" ||
    !/^@[a-z0-9-]+\/[a-z0-9._/-]+$/i.test(row.name) || row.name.length > 1024) return null;
  const property = (name: string): unknown => {
    const entries = row.properties?.filter((item) => item.property_id === name);
    return entries?.length === 1 ? entries[0]?.value : undefined;
  };
  const context = property("context_window");
  const contextTokens = typeof context === "string" && /^\d+$/.test(context) &&
    Number.isSafeInteger(Number(context)) && Number(context) > 0 ? Number(context) : null;
  // No currency parsing: native price/rate/cost properties (including per-neuron
  // or per-token units) are ignored. Old snapshots may retain extra rate fields;
  // this boundary never reads them and performs no neuron conversion.
  const effort = property("reasoning_effort");
  const supportedEfforts = effort !== null && typeof effort === "object" && "supported_efforts" in effort
    ? effort.supported_efforts : undefined;
  const nativeReasoningEfforts = Array.isArray(supportedEfforts) &&
    supportedEfforts.every((value: unknown) => typeof value === "string") ? [...supportedEfforts] : undefined;
  const lowEffort = Array.isArray(supportedEfforts) && supportedEfforts.includes("low");
  return { route: "workers-ai:" + row.name, id: row.name, label: row.name, enabled: true,
    contextTokens, maxOutputTokens: null, outputReserveTokens: 8192,
    ...(nativeReasoningEfforts ? { nativeReasoningEfforts } : {}),
    ...(lowEffort ? { nativeReasoningEffort: "low" as const } : {}),
    checkedOn };
}

export async function discoverNativeModels(ai: Ai): Promise<CatalogModel[]> {
  const models = new Map<string, CatalogModel>(), checkedOn = new Date().toISOString().slice(0, 10);
  for (let page = 1; page <= MAX_ROWS / PAGE_SIZE; page++) {
    const rows = await ai.models({ page, per_page: PAGE_SIZE });
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new Error("Invalid Workers AI catalogue page.");
    for (const row of rows) {
      const model = nativeModel(row, checkedOn);
      if (model && !models.has(model.route)) models.set(model.route, model);
    }
    if (rows.length < PAGE_SIZE) return [...models.values()];
  }
  throw new Error("Workers AI catalogue exceeds the discovery row bound.");
}
