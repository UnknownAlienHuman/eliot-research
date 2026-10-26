import { LibraryError } from "./library";

export interface ModelSpec {
  route: string;
  id: "@cf/zai-org/glm-5.3-flash" | "@cf/zai-org/glm-5.3";
  label: string;
  contextTokens: number;
  maxOutputTokens: number;
  inputMicrousdPerMillion: number;
  cachedMicrousdPerMillion: number;
  outputMicrousdPerMillion: number;
  checkedOn: string;
  enabled: boolean;
}
export const DEFAULT_MODEL = "workers-ai:@cf/zai-org/glm-5.3-flash";
// Official model pages + pricing refreshed 2026-10-26; pricing page updated 2026-10-20.
export const MODELS: ModelSpec[] = [
  { route: DEFAULT_MODEL, id: "@cf/zai-org/glm-5.3-flash", label: "GLM 5.3 Flash", contextTokens: 1_048_576, maxOutputTokens: 8192,
    inputMicrousdPerMillion: 150000, cachedMicrousdPerMillion: 30000, outputMicrousdPerMillion: 500000, checkedOn: "2026-10-26", enabled: true },
  { route: "workers-ai:@cf/zai-org/glm-5.3", id: "@cf/zai-org/glm-5.3", label: "GLM 5.3", contextTokens: 1_048_576, maxOutputTokens: 8192,
    inputMicrousdPerMillion: 1400000, cachedMicrousdPerMillion: 260000, outputMicrousdPerMillion: 4400000, checkedOn: "2026-10-26", enabled: true },
];
export function requireModel(route: string): ModelSpec {
  const model = MODELS.find((item) => item.route === route && item.enabled);
  if (!model) throw new LibraryError("unavailable", "This model is unavailable or its current price has not been verified.", 503);
  return model;
}
