import { LibraryError } from "./library";
import { discoverGatewayModels } from "./model-catalog";
import { discoverNativeModels } from "./native-model-catalog";
import { z } from "zod";
import { readNativeUsage, readProviderQuotas } from "./model-quota";
import type { NativeUsage, NativeUsageEnvironment, ProviderQuota } from "./model-quota";
import { isOpenRouterApiBase } from "./shared/api";

export const modelProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  type: z.enum(["workers-ai", "openai-compatible"]),
  gatewaySlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).nullable(),
  gatewayPath: z.string().regex(/^(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/),
  baseUrl: z.string().trim().url().transform((value) => value.replace(/\/+$/, "")).nullable(),
  modelsUrl: z.string().trim().url().optional(),
  metadataUrl: z.string().trim().url().optional(),
  dataCollection: z.enum(["deny", "allow"]).optional(),
  enabled: z.boolean(),
}).strict().superRefine((provider, ctx) => {
  if (provider.type === "workers-ai") {
    if (provider.id !== "workers-ai" || provider.baseUrl !== null || provider.gatewaySlug !== null || provider.gatewayPath !== "" || provider.modelsUrl !== undefined || provider.metadataUrl !== undefined || provider.dataCollection !== undefined)
      ctx.addIssue({ code: "custom", message: "Workers AI uses its native binding and no base URL." });
  } else {
    let url: URL | null = null;
    try { url = provider.baseUrl ? new URL(provider.baseUrl) : null; } catch { /* Input validation reports malformed URLs below. */ }
    if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || provider.id === "workers-ai" || !provider.gatewaySlug)
      ctx.addIssue({ code: "custom", message: "Use a provider HTTPS base URL without credentials, query or fragment." });
    for (const endpoint of [provider.modelsUrl, provider.metadataUrl]) {
      if (endpoint === undefined) continue;
      let parsed: URL | null = null;
      try { parsed = new URL(endpoint); } catch { /* URL validation reports the malformed value. */ }
      if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
        ctx.addIssue({ code: "custom", message: "Use an HTTPS catalogue URL without credentials, query or fragment." });
    }
    if (provider.dataCollection !== undefined && !isOpenRouterApiBase(provider.baseUrl))
      ctx.addIssue({ code: "custom", message: "Data collection policy is supported by the OpenRouter API." });
  }
}).transform((provider) => isOpenRouterApiBase(provider.baseUrl)
  ? { ...provider, dataCollection: provider.dataCollection ?? "deny" as const }
  : provider);
export const modelProvidersSchema = z.array(modelProviderSchema).superRefine((providers, ctx) => {
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length)
    ctx.addIssue({ code: "custom", message: "Each provider ID must be unique." });
});
export type ModelProvider = z.infer<typeof modelProviderSchema>;

/** Published model endpoints may select a protocol beneath the owner-approved API root. */
export function isProviderApiBase(provider: ModelProvider, apiBaseUrl: string): boolean {
  if (!provider.baseUrl) return false;
  try {
    const root = new URL(provider.baseUrl), api = new URL(apiBaseUrl);
    if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash || api.origin !== root.origin) return false;
    const prefix = root.pathname.replace(/\/+$/, ""), path = api.pathname.replace(/\/+$/, "");
    if (path === prefix) return true;
    return !path.includes("%") && path.startsWith(prefix + "/");
  } catch { return false; }
}

export async function getModelProviders(env: Pick<Env, "DB">): Promise<ModelProvider[]> {
  const row = await env.DB.prepare("SELECT model_providers_json AS providers FROM settings WHERE id=1").first<{ providers: string }>();
  let value: unknown;
  try { value = row ? JSON.parse(row.providers) : null; } catch { value = null; }
  const providers = modelProvidersSchema.safeParse(value);
  if (!providers || !providers.success) throw new LibraryError("unavailable", "Provider settings are unavailable.", 503);
  return providers.data;
}
export async function saveModelProviders(env: Pick<Env, "DB">, providers: ModelProvider[]): Promise<ModelProvider[]> {
  const checked = modelProvidersSchema.parse(providers);
  await env.DB.prepare("UPDATE settings SET model_providers_json=?,updated_at=? WHERE id=1")
    .bind(JSON.stringify(checked), Date.now()).run();
  return checked;
}

export interface CatalogModel {
  route: string;
  id: string;
  label: string;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  outputReserveTokens?: number;
  responseFormat?: boolean;
  structuredOutputs?: boolean;
  supportsTemperature?: boolean;
  optionalReasoning?: boolean;
  apiProtocol?: "openai-chat" | "openai-responses" | "anthropic" | "google";
  apiBaseUrl?: string;
  mayTrainOnYourPrompts?: boolean;
  nativeReasoningEffort?: "low";
  checkedOn: string;
  enabled: boolean;
  unavailableReason?: string;
}
export interface ModelSpec extends CatalogModel {
  contextTokens: number;
  routing?: { provider: ModelProvider; gatewayId: string };
}
export const DEFAULT_MODEL = "workers-ai:@cf/zai-org/glm-5.3-flash";
// Owner-selected native default metadata is a fallback, not a provider allowlist.
export const MODELS: ModelSpec[] = [
  { route: DEFAULT_MODEL, id: "@cf/zai-org/glm-5.3-flash", label: "GLM 5.3 Flash", contextTokens: 1_048_576,
    maxOutputTokens: null, outputReserveTokens: 8192, nativeReasoningEffort: "low", checkedOn: "2026-10-30", enabled: true },
];
export const modelOutputLimit = (model: Pick<CatalogModel, "outputReserveTokens" | "maxOutputTokens">) => {
  const bound = model.outputReserveTokens ?? model.maxOutputTokens ?? 0;
  return Math.min(bound, model.maxOutputTokens ?? bound);
};
export function modelTokenLimit(model: Pick<CatalogModel, "contextTokens" | "outputReserveTokens" | "maxOutputTokens">): number {
  const output = modelOutputLimit(model), total = (model.contextTokens ?? 0) + output;
  if (!Number.isSafeInteger(model.contextTokens) || (model.contextTokens ?? 0) <= 0 ||
    !Number.isSafeInteger(output) || output <= 0 || !Number.isSafeInteger(total))
    throw new LibraryError("unavailable", "The model has no usable input/output limits.", 503);
  return total;
}
function missingMetadata(model: CatalogModel): string | null {
  if (!Number.isSafeInteger(model.contextTokens) || (model.contextTokens ?? 0) <= 0 ||
    !Number.isSafeInteger(modelOutputLimit(model)) || modelOutputLimit(model) <= 0)
    return "The provider has not published usable context/output metadata.";
  return null;
}
function resolved(model: CatalogModel | undefined, route: string): ModelSpec {
  const reason = model ? missingMetadata(model) : "This model is absent from the current provider catalogue.";
  if (!model || !model.enabled || reason) throw new LibraryError("unavailable", model?.unavailableReason ?? reason ?? "This model is unavailable.", 503);
  modelTokenLimit(model);
  return { ...model, route, contextTokens: model.contextTokens as number };
}
export const validGatewayId = (id: string) => id !== "default" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
export async function getModelConnection(env: Pick<Env, "DB">) {
  const row = await env.DB.prepare("SELECT model_gateway_id AS gatewayId FROM settings WHERE id=1").first<{ gatewayId: string | null }>();
  return { gatewayId: row?.gatewayId && validGatewayId(row.gatewayId) ? row.gatewayId : null,
    provider: "ai-gateway" as const, alias: "default" as const };
}
type ModelEnvironment = Pick<Env, "DB" | "BUCKET"> & Partial<Pick<Env, "AI">> & NativeUsageEnvironment;
interface StoredModelCatalog {
  updatedAt: string;
  warnings: string[];
  models: CatalogModel[];
  providers?: ModelProvider[];
  quotas?: ProviderQuota[];
  quotaGatewayId?: string | null;
  nativeUsage?: NativeUsage;
}
export interface ModelCatalogView {
  models: CatalogModel[];
  warnings: string[];
  providers: ModelProvider[];
  gatewayId: string | null;
  quotas: ProviderQuota[];
  nativeUsage?: NativeUsage;
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
    !nullableFinite(value.contextTokens) || !nullableFinite(value.maxOutputTokens)) return false;
  if (value.outputReserveTokens !== undefined && (!Number.isSafeInteger(value.outputReserveTokens) || (value.outputReserveTokens as number) <= 0)) return false;
  if (value.responseFormat !== undefined && typeof value.responseFormat !== "boolean") return false;
  if (value.structuredOutputs !== undefined && typeof value.structuredOutputs !== "boolean") return false;
  if (value.supportsTemperature !== undefined && typeof value.supportsTemperature !== "boolean") return false;
  if (value.optionalReasoning !== undefined && typeof value.optionalReasoning !== "boolean") return false;
  if (value.nativeReasoningEffort !== undefined && value.nativeReasoningEffort !== "low") return false;
  if (value.apiProtocol !== undefined && !["openai-chat", "openai-responses", "anthropic", "google"].includes(String(value.apiProtocol))) return false;
  if (value.apiBaseUrl !== undefined && typeof value.apiBaseUrl !== "string") return false;
  if (value.mayTrainOnYourPrompts !== undefined && typeof value.mayTrainOnYourPrompts !== "boolean") return false;
  return value.unavailableReason === undefined || typeof value.unavailableReason === "string";
}
function isStoredModelCatalog(value: unknown): value is StoredModelCatalog {
  return isRecord(value) && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) &&
    Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string") &&
    Array.isArray(value.models) && value.models.every(isCatalogModel) &&
    (value.providers === undefined || modelProvidersSchema.safeParse(value.providers).success);
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
export function providerForRoute(providers: ModelProvider[], route: string): ModelProvider | undefined {
  return providers.find((provider) => provider.type === "workers-ai"
    ? route.startsWith("workers-ai:") : route.startsWith(`gateway:${provider.id}/`));
}
function sameProviderRoute(provider: ModelProvider, previous: ModelProvider | undefined): boolean {
  // Data-use choice is frozen on admission; it does not change catalogue identity.
  return previous !== undefined && previous.type === provider.type && previous.baseUrl === provider.baseUrl &&
    previous.gatewaySlug === provider.gatewaySlug && previous.gatewayPath === provider.gatewayPath &&
    previous.modelsUrl === provider.modelsUrl && previous.metadataUrl === provider.metadataUrl;
}
function isProviderQuota(value: unknown): value is ProviderQuota {
  return isRecord(value) && typeof value.providerId === "string" &&
    [value.usage, value.limit].every((amount) => amount === null || (typeof amount === "number" && Number.isFinite(amount) && amount >= 0)) &&
    (value.error === null || typeof value.error === "string");
}
function isNativeUsage(value: unknown): value is NativeUsage {
  return isRecord(value) && value.allowanceNeurons === 10_000 &&
    (value.neurons === null || (typeof value.neurons === "number" && Number.isFinite(value.neurons) && value.neurons >= 0)) &&
    typeof value.dayStart === "string" && Number.isFinite(Date.parse(value.dayStart)) &&
    typeof value.resetAt === "string" && Number.isFinite(Date.parse(value.resetAt)) &&
    (value.error === null || typeof value.error === "string");
}
function snapshotModels(snapshot: StoredModelCatalog | null, gatewayId: string | null, providers: ModelProvider[]): CatalogModel[] {
  const models = new Map<string, CatalogModel>(MODELS.map((model) => [model.route, { ...model }]));
  for (const model of snapshot?.models ?? []) {
    const fallback = models.get(model.route);
    const visible: CatalogModel = { route: model.route, id: model.id, label: model.label, contextTokens: model.contextTokens,
      maxOutputTokens: model.maxOutputTokens, checkedOn: model.checkedOn, enabled: model.enabled };
    for (const field of ["outputReserveTokens", "responseFormat", "structuredOutputs", "supportsTemperature", "optionalReasoning",
      "nativeReasoningEffort", "apiProtocol", "apiBaseUrl", "mayTrainOnYourPrompts", "unavailableReason"] as const) {
      if (model[field] !== undefined) Object.assign(visible, { [field]: model[field] });
    }
    models.set(model.route, { ...visible, label: fallback?.label ?? model.label,
      maxOutputTokens: model.maxOutputTokens ?? fallback?.maxOutputTokens ?? null });
  }
  for (const [route, model] of models) {
    const provider = providerForRoute(providers, route);
    const previous = snapshot?.providers?.find((entry) => entry.id === provider?.id);
    const changed = provider?.type === "openai-compatible" && !sameProviderRoute(provider, previous);
    const reason = !provider ? "Provider is not configured." : !provider.enabled ? "Provider is disabled."
      : route.startsWith("gateway:") && !gatewayId ? "Connect AI Gateway in Settings."
        : changed ? "Refresh models after editing provider settings." : null;
    if (reason) models.set(route, { ...model, enabled: false, unavailableReason: reason });
  }
  return [...models.values()];
}
export async function readModelCatalog(env: ModelEnvironment): Promise<ModelCatalogView> {
  const [stored, connection, providers] = await Promise.all([readStoredModelCatalog(env), getModelConnection(env), getModelProviders(env)]);
  const warnings = stored.ok
    ? [...(stored.snapshot?.warnings ?? [])]
    : [SNAPSHOT_UNAVAILABLE];
  if (stored.ok && stored.snapshot === null) warnings.push(REFRESH_NEEDED);
  const snapshot = stored.ok ? stored.snapshot : null;
  const storedQuotas = Array.isArray(snapshot?.quotas) ? snapshot.quotas.filter(isProviderQuota) : [];
  const quotas = providers.map<ProviderQuota>((provider) => {
    const prior = snapshot?.providers?.find((entry) => entry.id === provider.id);
    const quota = storedQuotas.find((entry) => entry.providerId === provider.id);
    return provider.enabled && snapshot?.quotaGatewayId === connection.gatewayId && sameProviderRoute(provider, prior) && quota
      ? { providerId: quota.providerId, usage: quota.usage, limit: quota.limit, error: quota.error }
      : { providerId: provider.id, usage: null, limit: null, error: "quota-unknown" };
  });
  return {
    models: snapshotModels(stored.ok ? stored.snapshot : null, connection.gatewayId, providers),
    warnings,
    providers,
    gatewayId: connection.gatewayId,
    quotas,
    ...(isNativeUsage(snapshot?.nativeUsage) && snapshot.nativeUsage.dayStart.slice(0, 10) === new Date().toISOString().slice(0, 10)
      ? { nativeUsage: snapshot.nativeUsage } : {}),
    snapshot: { updatedAt: stored.ok ? stored.snapshot?.updatedAt ?? null : null,
      refreshNeeded: !stored.ok || stored.snapshot === null || warnings.length > 0 },
  };
}
export async function availableModels(env: ModelEnvironment): Promise<CatalogModel[]> {
  return (await readModelCatalog(env)).models;
}
export async function refreshModelCatalog(env: ModelEnvironment): Promise<ModelCatalogView> {
  const previous = await readStoredModelCatalog(env);
  if (!previous.ok) throw new LibraryError("unavailable", "The existing model catalogue snapshot could not be read; refresh was not saved.", 503);

  const warnings: string[] = [];
  const [providers, connection] = await Promise.all([getModelProviders(env), getModelConnection(env)]);
  const failedProviders = new Set<string>();
  const nativeEnabled = providers.some((provider) => provider.type === "workers-ai" && provider.enabled);
  const ai = env.AI as unknown as Pick<Fetcher, "fetch"> | undefined;
  const gatewayAccess = connection.gatewayId && ai && typeof ai.fetch === "function" ? { id: connection.gatewayId, ai } : undefined;
  const [gateway, native, quotas, nativeUsage] = await Promise.allSettled([
    discoverGatewayModels(providers, (id, warning) => { failedProviders.add(id); warnings.push(warning); }, gatewayAccess),
    nativeEnabled ? env.AI ? discoverNativeModels(env.AI) : Promise.resolve(null) : Promise.resolve([]),
    readProviderQuotas(env, providers, connection),
    readNativeUsage(env),
  ]);
  if (gateway.status === "rejected") {
    for (const provider of providers) if (provider.type === "openai-compatible" && provider.enabled) failedProviders.add(provider.id);
    warnings.push("External model catalogues could not be refreshed.");
  }
  const nativeFailed = native.status === "rejected" || (native.status === "fulfilled" && native.value === null);
  if (nativeFailed) warnings.push("Workers AI model catalogue is unavailable.");

  const models = new Map<string, CatalogModel>();
  for (const model of previous.snapshot?.models ?? []) {
    const provider = providerForRoute(providers, model.route);
    if (provider && (!provider.enabled || failedProviders.has(provider.id) || (provider.type === "workers-ai" && nativeFailed))) models.set(model.route, model);
  }
  if (gateway.status === "fulfilled") for (const model of gateway.value) models.set(model.route, model);
  if (!nativeFailed && native.status === "fulfilled" && native.value !== null) {
    for (const model of native.value) models.set(model.route, model);
  }

  const refreshedProviders = providers.flatMap((provider) => {
    const failed = !provider.enabled || failedProviders.has(provider.id) || (provider.type === "workers-ai" && nativeFailed);
    const prior = previous.snapshot?.providers?.find((entry) => entry.id === provider.id);
    return failed ? prior ? [{ ...prior, enabled: provider.enabled }] : [] : [provider];
  });
  const quotaValues = quotas.status === "fulfilled" ? quotas.value : providers.map<ProviderQuota>((provider) =>
    ({ providerId: provider.id, usage: null, limit: null, error: "quota-unavailable" }));
  const snapshot: StoredModelCatalog = { updatedAt: new Date().toISOString(), warnings, models: [...models.values()], providers: refreshedProviders,
    quotas: quotaValues, quotaGatewayId: connection.gatewayId,
    ...(nativeUsage.status === "fulfilled" ? { nativeUsage: nativeUsage.value } : {}) };
  const serialized = JSON.stringify(snapshot);
  if (new TextEncoder().encode(serialized).byteLength > MAX_MODEL_CATALOG_BYTES)
    throw new LibraryError("unavailable", "The model catalogue exceeds its storage bound; the previous snapshot was kept.", 503);
  await env.BUCKET.put(MODEL_CATALOG_KEY, serialized, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  return readModelCatalog(env);
}
function catalogModel(models: CatalogModel[], route: string): CatalogModel {
  const matches = models.filter((model) => model.route === route);
  if (matches.length > 1) throw new LibraryError("unavailable", "This model identity is ambiguous.", 503);
  const model = matches[0];
  if (!model || !model.enabled) throw new LibraryError("unavailable", model?.unavailableReason ?? "This model is absent from the current provider catalogue.", 503);
  return { ...model, route };
}
export async function requireCatalogModel(env: ModelEnvironment, route: string): Promise<CatalogModel> {
  return catalogModel((await readModelCatalog(env)).models, route);
}
export async function requireAvailableModel(env: ModelEnvironment, route: string): Promise<ModelSpec> {
  const catalog = await readModelCatalog(env);
  const model = resolved(catalogModel(catalog.models, route), route);
  if (!route.startsWith("gateway:")) return model;
  const provider = providerForRoute(catalog.providers, route);
  if (!provider || !provider.enabled || !catalog.gatewayId) throw new LibraryError("unavailable", "The provider connection is unavailable.", 503);
  if ((provider.metadataUrl && (!model.apiProtocol || !model.apiBaseUrl)) ||
    (model.apiBaseUrl !== undefined && !isProviderApiBase(provider, model.apiBaseUrl)))
    throw new LibraryError("unavailable", "Refresh the provider's published model API metadata before starting a request.", 503);
  return { ...model, routing: { provider: { ...provider }, gatewayId: catalog.gatewayId } };
}
