import { createAI } from "agents/models/ai-sdk";
import type { LanguageModel, LanguageModelUsage } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import { LibraryError } from "./library";
import { type ModelSpec } from "./models";
import type { ProviderUsage } from "./shared/api";

const EXTERNAL_FAILURE =
  "External model request failed. Check the Gateway connection and provider status; no retry was started.";
const NATIVE_FAILURE = "Model stream failed.";

type ProviderConvertUsage = NonNullable<OpenAICompatibleProviderSettings["convertUsage"]>;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const OFFICIAL_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
function isNativeOpenRouterRoute(model?: Pick<ModelSpec, "route" | "routing">): boolean {
  const provider = model?.routing?.provider;
  return provider?.gatewaySlug === "openrouter" && provider?.gatewayPath === "v1" && typeof provider?.baseUrl === "string" && provider.baseUrl.trim().replace(/\/+$/, "") === OFFICIAL_OPENROUTER_BASE_URL;
}
export function reportedProviderUsage(usage: LanguageModelUsage, model?: Pick<ModelSpec, "route" | "routing">): ProviderUsage | null {
  const raw = usage.raw;
  if (!raw) return null;
  const input = raw.prompt_tokens_details, output = raw.completion_tokens_details;
  const cached = input && typeof input === "object" && "cached_tokens" in input ? input.cached_tokens : undefined;
  const reasoning = output && typeof output === "object" && "reasoning_tokens" in output ? output.reasoning_tokens : undefined;
  return { inputTokens: count(raw.prompt_tokens) ?? null, outputTokens: count(raw.completion_tokens) ?? null,
    totalTokens: count(raw.total_tokens) ?? null, cachedTokens: count(cached) ?? null, reasoningTokens: count(reasoning) ?? null,
    // OpenAI-compatible raw.cost has no standard currency; only verified official OpenRouter routing is USD.
    costUsd: isNativeOpenRouterRoute(model) && typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : null };
}

// Narrow compatible-usage fix (pinned @ai-sdk/openai-compatible 3.0.79): the bundled
// converter coerces missing counts to 0, which wrongly settles usage as zero on priced
// routes. Unknown stays unknown here; output follows the same max(completion,
// total - prompt) rule as the native path and never subtracts reasoning (OpenRouter
// completion totals already include it). Contradictory detail counts reset to unknown,
// and a total below prompt or reasoning above the computed output keeps output unknown
// so the reservation is retained instead of billing an inconsistent number.
export const convertCompatibleUsage: ProviderConvertUsage = (usage) => {
  const prompt = count(usage?.prompt_tokens);
  let cacheRead = count(usage?.prompt_tokens_details?.cached_tokens);
  if (cacheRead !== undefined && prompt !== undefined && cacheRead > prompt) cacheRead = undefined;
  const completion = count(usage?.completion_tokens);
  const reportedReasoning = count(usage?.completion_tokens_details?.reasoning_tokens);
  let reasoning = reportedReasoning;
  if (reasoning !== undefined && completion !== undefined && reasoning > completion) reasoning = undefined;
  const total = count(usage?.total_tokens);
  let output: number | undefined;
  if (total !== undefined && prompt !== undefined) {
    output = total < prompt ? undefined : Math.max(completion ?? 0, total - prompt);
  } else {
    output = completion;
  }
  if (output !== undefined && reportedReasoning !== undefined && reportedReasoning > output) {
    output = undefined;
    reasoning = undefined;
  }
  return {
    inputTokens: {
      total: prompt,
      noCache: prompt === undefined ? undefined : Math.max(0, prompt - (cacheRead ?? 0)),
      cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: undefined, reasoning },
    // Provider usage has already been parsed from JSON by the SDK.
    ...(usage ? { raw: usage as JSONObject } : {}),
  };
};

// Narrow OpenRouter body transform (pinned provider contract): disable upstream
// paid fallback and require declared parameters. responseFormatAllowed means the
// catalog entry explicitly allows a response_format field (json_object for
// non-schema models); otherwise the vendor-emitted field is stripped because the
// provider contract forbids it. The caller adds the explicit schema instruction
// when model.responseFormat is false; Output.object parses locally either way
// and failures stay local with no repair calls.
// Temperature 0 is app strategy for determinism within the published 0-2 range
// (official OpenRouter ChatRequest), sent only when the catalogue advertises
// "temperature"; otherwise omitted so provider defaults apply (no fake defaults).
// Structured-output reasoning off is bounded-output recovery: when the Workflow
// passes structuredOutput:true and the catalogue publishes optionalReasoning
// (reasoning.mandatory === false plus advertised "reasoning"), the official
// OpenRouter body sends reasoning:{enabled:false} (documented ReasoningConfig).
// Never for chat (structuredOutput false), natively mandatory, or unknown; never
// on the generic compatible body (standard temperature may forward there).
// Generic compatible body for the native gateway fetch: no provider routing hint;
// strip response_format unless the catalog explicitly advertises it. Structured
// output is enabled only when the catalog sets structuredOutputs; otherwise the
// caller codec handles plain JSON locally.
function compatibleBody(responseFormatAllowed: boolean, supportsTemperature: boolean) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...args };
    delete out.provider;
    if (!responseFormatAllowed) delete out.response_format;
    if (supportsTemperature) out.temperature = 0;
    return out;
  };
}
function openRouterBody(responseFormatAllowed: boolean, options: { supportsTemperature: boolean; optionalReasoning: boolean; structuredOutput: boolean }) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const provider = { ...(args.provider as Record<string, unknown> | undefined), allow_fallbacks: false, require_parameters: true };
    const out: Record<string, unknown> = { ...args, provider };
    if (!responseFormatAllowed) delete out.response_format;
    if (options.supportsTemperature) out.temperature = 0;
    if (options.structuredOutput && options.optionalReasoning) out.reasoning = { enabled: false };
    return out;
  };
}

export async function resolveModelTransport(
  env: Pick<Env, "AI" | "DB">,
  model: ModelSpec,
  sessionAffinity: string,
  options: { structuredOutput?: boolean } = {},
): Promise<LanguageModel> {
  if (model.route.startsWith("workers-ai:")) {
    return createAI({ binding: env.AI }).languageModel(model.id, { ...(model.nativeReasoningEffort ? { reasoningEffort: model.nativeReasoningEffort } : {}), sessionAffinity });
  }
  if (!model.route.startsWith("gateway:")) {
    throw new LibraryError("unavailable", "This model route is not supported.", 503);
  }
  const routing = model.routing;
  if (!routing || !routing.provider || typeof routing.gatewayId !== "string" || !routing.gatewayId
    || routing.gatewayId === "default" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(routing.gatewayId)) {
    throw new LibraryError("unavailable", "This model route is not supported.", 503);
  }
  const provider = routing.provider;
  const gatewayId = routing.gatewayId;
  if (provider.type !== "openai-compatible" || !provider.enabled) {
    throw new LibraryError("unavailable", "This model route is not supported.", 503);
  }
  // Frozen route: exact gateway:<provider.id>/<model.id> for every compatible provider.
  if (!model.id.trim() || model.route !== `gateway:${provider.id}/${model.id}`) {
    throw new LibraryError("unavailable", "This model route is not supported.", 503);
  }
  if (!provider.baseUrl || !provider.gatewaySlug) {
    throw new LibraryError("unavailable", "This model route is not supported.", 503);
  }
  if (isNativeOpenRouterRoute(model)) {
    const structured = model.structuredOutputs === true;
    const responseFormatAllowed = model.responseFormat === true;
    const transportOptions = {
      supportsTemperature: model.supportsTemperature === true,
      optionalReasoning: model.optionalReasoning === true,
      structuredOutput: options.structuredOutput === true,
    };
    const openrouter = createOpenAICompatible<string, string, string, string>({
      name: "openrouter",
      baseURL: provider.baseUrl,
      includeUsage: true,
      supportsStructuredOutputs: structured,
      transformRequestBody: openRouterBody(responseFormatAllowed, transportOptions),
      convertUsage: convertCompatibleUsage,
    });
    const vendor = openrouter.languageModel(model.id);
    return createAI({ binding: env.AI }).languageModel(vendor, {
      sessionAffinity,
      headers: {
        "cf-aig-no-wholesale": "true",
        "cf-aig-max-attempts": "1",
        "cf-aig-skip-cache": "true",
        "cf-aig-collect-log": "false",
      },
      gateway: { id: gatewayId, skipCache: true, collectLog: false, retries: { maxAttempts: 1 } },
      vendorKey: "gateway",
    });
  }
  const baseURL = provider.baseUrl.replace(/\/+$/, "");
  const gatewayPath = provider.gatewayPath ? `/${provider.gatewayPath}` : "";
  const gatewayUrl =
    "https://workers-binding.ai/ai-gateway/gateways/" + encodeURIComponent(gatewayId) + `/${provider.gatewaySlug}` + gatewayPath + "/chat/completions";
  const responseFormatAllowed = model.responseFormat === true;
  const structured = model.structuredOutputs === true;
  const supportsTemperature = model.supportsTemperature === true;
  const transportOptions = {
    supportsTemperature,
    optionalReasoning: model.optionalReasoning === true,
    structuredOutput: options.structuredOutput === true,
  };
  return createOpenAICompatible({
    name: provider.id, baseURL, includeUsage: true,
    supportsStructuredOutputs: structured, convertUsage: convertCompatibleUsage,
    transformRequestBody: baseURL === OFFICIAL_OPENROUTER_BASE_URL ? openRouterBody(responseFormatAllowed, transportOptions) : compatibleBody(responseFormatAllowed, supportsTemperature),
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== baseURL + "/chat/completions" || init?.method !== "POST" || typeof init.body !== "string")
        throw new LibraryError("unavailable", "This provider endpoint is not supported.", 503);
      init.signal?.throwIfAborted();
      const headers = { "Content-Type": "application/json", "x-session-affinity": sessionAffinity,
        "cf-aig-no-wholesale": "true", "cf-aig-max-attempts": "1", "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false" };
      // Native binding mechanism: Agents 0.30.1, packages/agents/src/models/core/transport.ts.
      // Ai.fetch is not declared in the pinned types; preserve its receiver with this narrow cast.
      return (env.AI as unknown as Pick<Fetcher, "fetch">).fetch(
        gatewayUrl,
        { method: "POST", body: init.body, headers, ...(init.signal ? { signal: init.signal } : {}) });
    },
  }).languageModel(model.id);
}

export function modelFailure(error: unknown, model: ModelSpec): string {
  const status = errorStatusCode(error);
  if (model.route.startsWith("gateway:")) {
    if (status !== undefined) {
      return "External model request failed (HTTP " + status + "). Check the Gateway connection and provider status; no retry was started.";
    }
    return EXTERNAL_FAILURE;
  }
  if (status !== undefined) {
    return "Model stream failed (HTTP " + status + ").";
  }
  return NATIVE_FAILURE;
}

function errorStatusCode(error: unknown): number | undefined {
  const direct = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  const checked = checkStatusCode(direct);
  if (checked !== undefined) return checked;
  const cause = error instanceof Error ? error.cause : undefined;
  return checkStatusCode((cause as { statusCode?: unknown } | null | undefined)?.statusCode);
}

function checkStatusCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

// Shared projection for operator logs. Keeps only a validated HTTP status;
// provider messages, bodies, codes and request data stay private. No retry is
// started from this projection; callers surface the stored message as-is.
export function safeErrorLogProjection(error: unknown): { name: string; status?: number } {
  const status = errorStatusCode(error);
  return { name: error instanceof Error ? "Error" : "unknown", ...(status === undefined ? {} : { status }) };
}
