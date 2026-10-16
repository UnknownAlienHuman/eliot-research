import { AiUsageObservationSchema, type AiUsageObservation } from "@eliotr/contracts";
import type { LegacyHttpAdapter } from "../legacy/http.js";

export async function readAiUsageObservation(
  http: Pick<LegacyHttpAdapter, "requestApi">, generation: string, signal?: AbortSignal,
): Promise<AiUsageObservation> {
  const raw = await http.requestApi("/api/v1/system/ai-usage", signal === undefined ? {} : { signal });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) ||
      !("deployment_generation" in raw) || raw.deployment_generation !== generation || !("data" in raw)) {
    throw new Error("AI usage belongs to another deployment or has an invalid envelope");
  }
  return AiUsageObservationSchema.parse(raw.data);
}
