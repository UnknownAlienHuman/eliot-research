import { LibraryError } from "./library";

export interface ModelSpec {
  route: string;
  id: string;
  label: string;
  contextTokens: number;
  maxOutputTokens: number;
  outputReserveTokens?: number;
  responseFormat?: boolean;
  structuredOutputs?: boolean;
  inputMicrousdPerMillion: number;
  cachedMicrousdPerMillion: number;
  outputMicrousdPerMillion: number;
  checkedOn: string;
  enabled: boolean;
  unavailableReason?: string;
}
export const DEFAULT_MODEL = "workers-ai:@cf/zai-org/glm-5.3-flash";
// Official model pages + pricing refreshed 2026-10-26; pricing page updated 2026-10-20.
export const MODELS: ModelSpec[] = [
  { route: DEFAULT_MODEL, id: "@cf/zai-org/glm-5.3-flash", label: "GLM 5.3 Flash", contextTokens: 1_048_576, maxOutputTokens: 8192,
    inputMicrousdPerMillion: 150000, cachedMicrousdPerMillion: 30000, outputMicrousdPerMillion: 500000, checkedOn: "2026-10-26", enabled: true },
  { route: "workers-ai:@cf/zai-org/glm-5.3", id: "@cf/zai-org/glm-5.3", label: "GLM 5.3", contextTokens: 1_048_576, maxOutputTokens: 8192,
    inputMicrousdPerMillion: 1400000, cachedMicrousdPerMillion: 260000, outputMicrousdPerMillion: 4400000, checkedOn: "2026-10-26", enabled: true },
  // OpenRouter public catalog, checked 2026-10-26. Provider caps are not reduced by the per-job output reserve.
  { route: "gateway:openrouter/dots-studio/dots-3-note-preview:free", id: "dots-studio/dots-3-note-preview:free", label: "Dots 3 Note Preview · free", contextTokens: 512_000, maxOutputTokens: 460_800,
    outputReserveTokens: 8192, responseFormat: true, structuredOutputs: true,
    inputMicrousdPerMillion: 0, cachedMicrousdPerMillion: 0, outputMicrousdPerMillion: 0, checkedOn: "2026-10-26", enabled: true },
  { route: "gateway:openrouter/thinkingmachines/inkling:free", id: "thinkingmachines/inkling:free", label: "Inkling · free", contextTokens: 1_048_576, maxOutputTokens: 262_144,
    outputReserveTokens: 8192, responseFormat: false, structuredOutputs: false,
    inputMicrousdPerMillion: 0, cachedMicrousdPerMillion: 0, outputMicrousdPerMillion: 0, checkedOn: "2026-10-26", enabled: true },
  { route: "gateway:openrouter/nvidia/nemotron-3.5-super-vl:free", id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super VL · free", contextTokens: 1_000_000, maxOutputTokens: 131_072,
    outputReserveTokens: 8192, responseFormat: true, structuredOutputs: true,
    inputMicrousdPerMillion: 0, cachedMicrousdPerMillion: 0, outputMicrousdPerMillion: 0, checkedOn: "2026-10-26", enabled: true },
];
export const modelOutputLimit = (model: Pick<ModelSpec, "outputReserveTokens" | "maxOutputTokens">) => Math.min(model.outputReserveTokens ?? model.maxOutputTokens, model.maxOutputTokens);
export function requireModel(route: string): ModelSpec {
  const model = MODELS.find((item) => item.route === route && item.enabled);
  if (!model) throw new LibraryError("unavailable", "This model is unavailable or its current price has not been verified.", 503);
  return model;
}

// No credentials are stored here. A named Gateway enables its OpenRouter default BYOK alias.
export const validGatewayId = (id: string) => id !== "default" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
export async function getModelConnection(env: Pick<Env, "DB">) {
  const row = await env.DB.prepare("SELECT model_gateway_id AS gatewayId FROM settings WHERE id=1").first<{ gatewayId: string | null }>();
  return { gatewayId: row?.gatewayId && validGatewayId(row.gatewayId) ? row.gatewayId : null,
    provider: "openrouter" as const, alias: "default" as const };
}
export async function availableModels(env: Pick<Env, "DB">): Promise<ModelSpec[]> {
  const connection = await getModelConnection(env);
  return MODELS.map((model) => model.route.startsWith("gateway:") && !connection.gatewayId
    ? { ...model, enabled: false, unavailableReason: "Connect OpenRouter in Settings." } : { ...model });
}
export async function requireAvailableModel(env: Pick<Env, "DB">, route: string): Promise<ModelSpec> {
  const model = requireModel(route);
  if (model.route.startsWith("gateway:") && !(await getModelConnection(env)).gatewayId)
    throw new LibraryError("unavailable", "External models are disconnected. Allow access to the existing Gateway credential in Settings first.", 503);
  return model;
}
