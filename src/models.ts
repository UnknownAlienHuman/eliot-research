import { LibraryError } from "./library";
import { discoverGatewayModels, enrichSelectedModel } from "./model-catalog";
import { discoverNativeModels } from "./native-model-catalog";

export interface CatalogModel {
  route: string;
  aliases?: string[];
  id: string;
  label: string;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  outputReserveTokens?: number;
  responseFormat?: boolean;
  structuredOutputs?: boolean;
  reasoning?: { enabled: false };
  nativeReasoningEffort?: "low";
  inputMicrousdPerMillion: number | null;
  cachedMicrousdPerMillion: number | null;
  outputMicrousdPerMillion: number | null;
  checkedOn: string;
  enabled: boolean;
  unavailableReason?: string;
}
export interface ModelSpec extends CatalogModel {
  contextTokens: number;
  inputMicrousdPerMillion: number;
  outputMicrousdPerMillion: number;
}
export const DEFAULT_MODEL = "workers-ai:@cf/zai-org/glm-5.3-flash";
// Owner-selected native default metadata is a fallback, not a provider allowlist.
export const MODELS: ModelSpec[] = [
  { route: DEFAULT_MODEL, id: "@cf/zai-org/glm-5.3-flash", label: "GLM 5.3 Flash", contextTokens: 1_048_576,
    maxOutputTokens: null, outputReserveTokens: 8192, inputMicrousdPerMillion: 150000, cachedMicrousdPerMillion: 30000,
    outputMicrousdPerMillion: 500000, checkedOn: "2026-10-27", enabled: true },
];
export const modelOutputLimit = (model: Pick<CatalogModel, "outputReserveTokens" | "maxOutputTokens">) => {
  const bound = model.outputReserveTokens ?? model.maxOutputTokens ?? 0;
  return Math.min(bound, model.maxOutputTokens ?? bound);
};
function missingMetadata(model: CatalogModel): string | null {
  if (!Number.isSafeInteger(model.contextTokens) || (model.contextTokens ?? 0) <= 0 ||
    !Number.isSafeInteger(modelOutputLimit(model)) || modelOutputLimit(model) <= 0)
    return "The provider has not published usable context/output metadata.";
  if (model.inputMicrousdPerMillion === null || model.outputMicrousdPerMillion === null ||
    ![model.inputMicrousdPerMillion, model.outputMicrousdPerMillion].every((n) => Number.isFinite(n) && n >= 0))
    return "The model's current price is unknown.";
  return null;
}
function resolved(model: CatalogModel | undefined, route: string): ModelSpec {
  const reason = model ? missingMetadata(model) : "This model is absent from the current provider catalogue.";
  if (!model || !model.enabled || reason) throw new LibraryError("unavailable", model?.unavailableReason ?? reason ?? "This model is unavailable.", 503);
  return { ...model, route, contextTokens: model.contextTokens as number,
    inputMicrousdPerMillion: model.inputMicrousdPerMillion as number,
    outputMicrousdPerMillion: model.outputMicrousdPerMillion as number };
}
export const validGatewayId = (id: string) => id !== "default" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
export async function getModelConnection(env: Pick<Env, "DB">) {
  const row = await env.DB.prepare("SELECT model_gateway_id AS gatewayId FROM settings WHERE id=1").first<{ gatewayId: string | null }>();
  return { gatewayId: row?.gatewayId && validGatewayId(row.gatewayId) ? row.gatewayId : null,
    provider: "ai-gateway" as const, alias: "default" as const };
}
type ModelEnvironment = Pick<Env, "DB" | "BUCKET"> & Partial<Pick<Env, "AI">>;
interface StoredModelCatalog {
  updatedAt: string;
  warnings: string[];
  models: CatalogModel[];
}
export interface ModelCatalogView {
  models: CatalogModel[];
  warnings: string[];
  snapshot: { updatedAt: string | null; refreshNeeded: boolean };
}
type StoredCatalogRead = { ok: true; snapshot: StoredModelCatalog | null } | { ok: false; snapshot: null };

const MODEL_CATALOG_KEY = "catalog/models.json";
const MAX_MODEL_CATALOG_BYTES = 16 * 1024 * 1024;
const REFRESH_NEEDED = "Model catalogue has not been refreshed. Use the explicit refresh action to discover provider models.";
const SNAPSHOT_UNAVAILABLE = "Model catalogue snapshot could not be read. Refresh it to retry.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nullableFinite(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}
function isCatalogModel(value: unknown): value is CatalogModel {
  if (!isRecord(value) || typeof value.route !== "string" || typeof value.id !== "string" ||
    typeof value.label !== "string" || typeof value.checkedOn !== "string" || typeof value.enabled !== "boolean" ||
    !nullableFinite(value.contextTokens) || !nullableFinite(value.maxOutputTokens) ||
    !nullableFinite(value.inputMicrousdPerMillion) || !nullableFinite(value.cachedMicrousdPerMillion) ||
    !nullableFinite(value.outputMicrousdPerMillion)) return false;
  if (value.aliases !== undefined && (!Array.isArray(value.aliases) || !value.aliases.every((alias) => typeof alias === "string"))) return false;
  if (value.outputReserveTokens !== undefined && (!Number.isSafeInteger(value.outputReserveTokens) || (value.outputReserveTokens as number) <= 0)) return false;
  if (value.responseFormat !== undefined && typeof value.responseFormat !== "boolean") return false;
  if (value.structuredOutputs !== undefined && typeof value.structuredOutputs !== "boolean") return false;
  if (value.reasoning !== undefined && (!isRecord(value.reasoning) || value.reasoning.enabled !== false)) return false;
  if (value.nativeReasoningEffort !== undefined && value.nativeReasoningEffort !== "low") return false;
  return value.unavailableReason === undefined || typeof value.unavailableReason === "string";
}
function isStoredModelCatalog(value: unknown): value is StoredModelCatalog {
  return isRecord(value) && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) &&
    Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string") &&
    Array.isArray(value.models) && value.models.every(isCatalogModel);
}
async function readStoredModelCatalog(env: ModelEnvironment): Promise<StoredCatalogRead> {
  try {
    const object = await env.BUCKET.get(MODEL_CATALOG_KEY);
    if (object === null) return { ok: true, snapshot: null };
    if (object.size > MAX_MODEL_CATALOG_BYTES) return { ok: false, snapshot: null };
    const value: unknown = await object.json<unknown>();
    return isStoredModelCatalog(value) ? { ok: true, snapshot: value } : { ok: false, snapshot: null };
  } catch {
    return { ok: false, snapshot: null };
  }
}
function snapshotModels(snapshot: StoredModelCatalog | null, gatewayId: string | null): CatalogModel[] {
  const models = new Map<string, CatalogModel>(MODELS.map((model) => [model.route, { ...model }]));
  for (const model of snapshot?.models ?? []) {
    const fallback = models.get(model.route);
    models.set(model.route, { ...model, label: fallback?.label ?? model.label,
      maxOutputTokens: model.maxOutputTokens ?? fallback?.maxOutputTokens ?? null });
  }
  if (!gatewayId) {
    for (const [route, model] of models) {
      if (route.startsWith("gateway:")) models.set(route, { ...model, enabled: false, unavailableReason: "Connect AI Gateway in Settings." });
    }
  }
  return [...models.values()];
}
export async function readModelCatalog(env: ModelEnvironment): Promise<ModelCatalogView> {
  const [stored, connection] = await Promise.all([readStoredModelCatalog(env), getModelConnection(env)]);
  const warnings = stored.ok
    ? [...(stored.snapshot?.warnings ?? [])]
    : [SNAPSHOT_UNAVAILABLE];
  if (stored.ok && stored.snapshot === null) warnings.push(REFRESH_NEEDED);
  return {
    models: snapshotModels(stored.ok ? stored.snapshot : null, connection.gatewayId),
    warnings,
    snapshot: { updatedAt: stored.ok ? stored.snapshot?.updatedAt ?? null : null,
      refreshNeeded: !stored.ok || stored.snapshot === null || warnings.length > 0 },
  };
}
export async function availableModels(env: ModelEnvironment): Promise<CatalogModel[]> {
  return (await readModelCatalog(env)).models;
}
export async function refreshModelCatalog(env: ModelEnvironment, selectedRoutes: string[] = []): Promise<ModelCatalogView> {
  const previous = await readStoredModelCatalog(env);
  if (!previous.ok) throw new LibraryError("unavailable", "The existing model catalogue snapshot could not be read; refresh was not saved.", 503);

  const warnings: string[] = [];
  const [gateway, native] = await Promise.allSettled([
    discoverGatewayModels((warning) => warnings.push(warning)),
    env.AI ? discoverNativeModels(env.AI) : Promise.resolve(null),
  ]);
  const failedProviders = new Set<string>();
  if (gateway.status === "fulfilled") {
    for (const warning of warnings) {
      if (warning.startsWith("command-code model catalogue ")) failedProviders.add("command-code");
      if (warning.startsWith("openrouter model catalogue ")) failedProviders.add("openrouter");
    }
  } else {
    failedProviders.add("command-code");
    failedProviders.add("openrouter");
    warnings.push("External model catalogues could not be refreshed.");
  }
  const nativeFailed = native.status === "rejected" || (native.status === "fulfilled" && native.value === null);
  if (nativeFailed) warnings.push("Workers AI model catalogue is unavailable.");

  const models = new Map<string, CatalogModel>();
  for (const model of previous.snapshot?.models ?? []) {
    const provider = model.route.startsWith("gateway:command-code/") ? "command-code"
      : model.route.startsWith("gateway:openrouter/") ? "openrouter" : model.route.startsWith("workers-ai:") ? "workers-ai" : null;
    if ((provider && failedProviders.has(provider)) || (provider === "workers-ai" && nativeFailed)) models.set(model.route, model);
  }
  if (gateway.status === "fulfilled") for (const model of gateway.value) models.set(model.route, model);
  if (!nativeFailed && native.status === "fulfilled" && native.value !== null) {
    for (const model of native.value) models.set(model.route, model);
  }

  const connection = await getModelConnection(env);
  const selected = new Set(selectedRoutes.filter((route) => typeof route === "string"));
  if (connection.gatewayId) {
    for (const model of [...models.values()]) {
      if (!model.enabled || !model.route.startsWith("gateway:command-code/") ||
        (!selected.has(model.route) && !model.aliases?.some((alias) => selected.has(alias)))) continue;
      try {
        models.set(model.route, await enrichSelectedModel(model));
      } catch {
        warnings.push("The selected Command Code model's pricing could not be verified. Selection is kept; prices remain Unknown.");
      }
      const enriched = models.get(model.route);
      if (enriched && (enriched.inputMicrousdPerMillion === null || enriched.outputMicrousdPerMillion === null))
        warnings.push("The selected Command Code model's pricing could not be verified. Selection is kept; prices remain Unknown.");
    }
  }

  const snapshot: StoredModelCatalog = { updatedAt: new Date().toISOString(), warnings, models: [...models.values()] };
  const serialized = JSON.stringify(snapshot);
  if (new TextEncoder().encode(serialized).byteLength > MAX_MODEL_CATALOG_BYTES)
    throw new LibraryError("unavailable", "The model catalogue exceeds its storage bound; the previous snapshot was kept.", 503);
  await env.BUCKET.put(MODEL_CATALOG_KEY, serialized, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  return readModelCatalog(env);
}
export async function requireCatalogModel(env: ModelEnvironment, route: string): Promise<CatalogModel> {
  const matches = (await availableModels(env)).filter((model) => model.route === route || model.aliases?.includes(route));
  if (matches.length > 1) throw new LibraryError("unavailable", "This model alias is ambiguous. Select its full catalogue ID.", 503);
  const model = matches[0];
  if (!model || !model.enabled) throw new LibraryError("unavailable", model?.unavailableReason ?? "This model is absent from the current provider catalogue.", 503);
  return { ...model, route };
}
export async function requireAvailableModel(env: ModelEnvironment, route: string): Promise<ModelSpec> {
  const model = await requireCatalogModel(env, route);
  return resolved(model, route);
}
