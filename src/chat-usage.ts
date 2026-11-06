import type { LanguageModelUsage } from "ai";
import { reportedProviderUsage } from "./model-transport";
import type { TurnView } from "./shared/api";

type UsageProjection = Partial<Pick<TurnView, "inputTokens" | "cachedTokens" | "outputTokens" | "tokenLimit" | "providerUsage">>;

// Project only reported SDK usage. An absent report cannot erase unknown counts
// or the held reservation; a proven undispatched turn has known zero usage.
export function turnUsageProjection(dispatched: boolean, usage: LanguageModelUsage | undefined): UsageProjection {
  const reported = usage ? {
    providerUsage: reportedProviderUsage(usage),
    inputTokens: usage.inputTokens ?? null,
    cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
  } : {};
  return dispatched ? reported : { ...reported, tokenLimit: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
}
