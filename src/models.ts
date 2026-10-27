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
    outputMicrousdPerMillion: 500000, nativeReasoningEffort: "low", checkedOn: "2026-10-27", enabled: true },
];
export const modelOutputLimit = (model: Pick<CatalogModel, "outputReserveTokens" | "maxOutputTokens">) => {
  const bound = model.outputReserveTokens ?? model.maxOutputTokens ?? 0;
  return Math.min(bound, model.maxOutputTokens ?? bound);
};
export function missingMetadata(model: CatalogModel): string | null {
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
type ModelEnvironment = Pick<Env, "DB"> & Partial<Pick<Env, "AI">>;
export async function availableModels(env: ModelEnvironment, selected?: string,
  onDiscoveryError?: (message: string) => void): Promise<CatalogModel[]> {
  const connection = await getModelConnection(env);
  let discovered: CatalogModel[] = [];
  const [external, native] = await Promise.allSettled([
    discoverGatewayModels(onDiscoveryError), env.AI ? discoverNativeModels(env.AI) : Promise.resolve([]),
  ]);
  if (external.status === "fulfilled") discovered = external.value;
  else onDiscoveryError?.("External model discovery is unavailable.");
  if (native.status === "fulfilled") discovered.push(...native.value);
  else onDiscoveryError?.("Workers AI model discovery is unavailable.");
  const models = new Map<string, CatalogModel>(MODELS.map((model) => [model.route, model]));
  for (const model of discovered) {
    const fallback = models.get(model.route);
    models.set(model.route, { ...model, label: fallback?.label ?? model.label,
      maxOutputTokens: model.maxOutputTokens ?? fallback?.maxOutputTokens ?? null });
  }
  return Promise.all([...models.values()].map(async (model) => {
    if (model.route.startsWith("gateway:") && !connection.gatewayId)
      return { ...model, enabled: false, unavailableReason: "Connect AI Gateway in Settings." };
    if (model.enabled && model.route.startsWith("gateway:command-code/") &&
      (model.route === selected || (selected !== undefined && model.aliases?.includes(selected)))) {
      const enriched = await enrichSelectedModel(model);
      if (enriched.inputMicrousdPerMillion === null || enriched.outputMicrousdPerMillion === null)
        onDiscoveryError?.("The selected Command Code model's pricing could not be verified. Selection is kept; prices remain Unknown.");
      return enriched;
    }
    return model;
  }));
}
export async function requireCatalogModel(env: ModelEnvironment, route: string): Promise<CatalogModel> {
  const fallback = MODELS.find((model) => model.route === route);
  if (fallback) {
    try {
      const native = env.AI ? await discoverNativeModels(env.AI) : [];
      return native.find((model) => model.route === route) ?? fallback;
    } catch { return fallback; }
  }
  const matches = (await availableModels(env)).filter((model) => model.route === route || model.aliases?.includes(route));
  if (matches.length > 1) throw new LibraryError("unavailable", "This model alias is ambiguous. Select its full catalogue ID.", 503);
  const model = matches[0];
  if (!model || !model.enabled) throw new LibraryError("unavailable", model?.unavailableReason ?? "This model is absent from the current provider catalogue.", 503);
  return { ...model, route };
}
export async function requireAvailableModel(env: ModelEnvironment, route: string): Promise<ModelSpec> {
  const model = await requireCatalogModel(env, route);
  return resolved(model.route.startsWith("gateway:command-code/") &&
    (model.inputMicrousdPerMillion === null || model.outputMicrousdPerMillion === null)
    ? await enrichSelectedModel(model) : model, route);
}
