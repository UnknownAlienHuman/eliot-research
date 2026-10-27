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
  const prices = property("price");
  const rate = (unit: string): number | null => {
    if (!Array.isArray(prices)) return null;
    const matches = prices.filter((item: unknown) => item !== null && typeof item === "object" &&
      "unit" in item && item.unit === unit);
    if (!matches.length || matches.some((item) => item.currency !== "USD" ||
      typeof item.price !== "number" || !Number.isFinite(item.price) || item.price < 0)) return null;
    const amount = Math.ceil(Math.max(...matches.map((item) => item.price as number)) * 1_000_000);
    return Number.isSafeInteger(amount) ? amount : null;
  };
  const effort = property("reasoning_effort");
  const lowEffort = effort !== null && typeof effort === "object" && "supported_efforts" in effort &&
    Array.isArray(effort.supported_efforts) && effort.supported_efforts.includes("low");
  return { route: "workers-ai:" + row.name, id: row.name, label: row.name, enabled: true,
    contextTokens, maxOutputTokens: null, outputReserveTokens: 8192,
    ...(lowEffort ? { nativeReasoningEffort: "low" as const } : {}),
    inputMicrousdPerMillion: rate("per M input tokens"),
    cachedMicrousdPerMillion: rate("per M cached input tokens"),
    outputMicrousdPerMillion: rate("per M output tokens"), checkedOn };
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
