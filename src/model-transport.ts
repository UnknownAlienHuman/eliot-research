import { createAI } from "agents/models/ai-sdk";
import type { LanguageModel, LanguageModelUsage } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import { LibraryError } from "./library";
import { getModelConnection, type ModelSpec } from "./models";
import type { ProviderUsage } from "./shared/api";

const OPENROUTER_PREFIX = "gateway:openrouter/";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const COMMAND_CODE_PREFIX = "gateway:command-code/";
const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai/provider/v1";

const EXTERNAL_FAILURE =
  "External model request failed. Check the Gateway connection and provider status; no retry was started.";
const NATIVE_FAILURE = "Model stream failed.";

type ProviderConvertUsage = NonNullable<OpenAICompatibleProviderSettings["convertUsage"]>;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function reportedProviderUsage(usage: LanguageModelUsage, route?: string): ProviderUsage | null {
  const raw = usage.raw;
  if (!raw) return null;
  const input = raw.prompt_tokens_details, output = raw.completion_tokens_details;
  const cached = input && typeof input === "object" && "cached_tokens" in input ? input.cached_tokens : undefined;
  const reasoning = output && typeof output === "object" && "reasoning_tokens" in output ? output.reasoning_tokens : undefined;
  return { inputTokens: count(raw.prompt_tokens) ?? null, outputTokens: count(raw.completion_tokens) ?? null,
    totalTokens: count(raw.total_tokens) ?? null, cachedTokens: count(cached) ?? null, reasoningTokens: count(reasoning) ?? null,
    // Command Code's cost currency is undocumented; keep raw private without naming it USD.
    costUsd: !route?.startsWith(COMMAND_CODE_PREFIX) && typeof raw.cost === "number" && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : null };
}

// Narrow compatible-usage fix (pinned @ai-sdk/openai-compatible 3.0.79): the bundled
// converter coerces missing counts to 0, which wrongly settles usage as zero on priced
// routes. Unknown stays unknown here; output follows the same max(completion,
// total - prompt) rule as the native path and never subtracts reasoning (OpenRouter
// completion totals already include it). Contradictory detail counts reset to unknown,
// and a total below prompt or reasoning above the computed output keeps output unknown
// so the reservation is retained instead of billing an inconsistent number.
const convertCompatibleUsage: ProviderConvertUsage = (usage) => {
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
// paid fallback and require declared parameters. For specs without JSON-schema
// support (Inkling) the vendor emits response_format json_object, which the
// provider contract forbids, so strip it. The caller adds the explicit schema
// instruction when model.responseFormat is false; Output.object parses locally
// either way and failures stay local with no repair calls.
function openRouterBody(structured: boolean, reasoning?: ModelSpec["reasoning"]) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const provider = { ...(args.provider as Record<string, unknown> | undefined), allow_fallbacks: false, require_parameters: true };
    const out: Record<string, unknown> = { ...args, provider, ...(reasoning ? { reasoning } : {}) };
    if (!structured) delete out.response_format;
    return out;
  };
}

export async function resolveModelTransport(
  env: Pick<Env, "AI" | "DB">,
  model: ModelSpec,
  sessionAffinity: string,
): Promise<LanguageModel> {
  const commandCode = model.route.startsWith(COMMAND_CODE_PREFIX);
  if (commandCode || model.route.startsWith(OPENROUTER_PREFIX)) {
    if (commandCode
      ? model.route === COMMAND_CODE_PREFIX || !model.id.trim() || model.responseFormat !== false || model.structuredOutputs === true
      : model.route !== OPENROUTER_PREFIX + model.id) {
      throw new LibraryError("unavailable", "This model route is not supported.", 503);
    }
    const connection = await getModelConnection(env);
    if (!connection.gatewayId) {
      throw new LibraryError("unavailable",
        "External models are disconnected. Allow access to the existing Gateway credential in Settings first.", 503);
    }
    if (commandCode) {
      const gatewayId = connection.gatewayId;
      return createOpenAICompatible({
        name: "command-code", baseURL: COMMAND_CODE_BASE_URL, includeUsage: true,
        supportsStructuredOutputs: false, convertUsage: convertCompatibleUsage,
        transformRequestBody: (args) => {
          const out = { ...args };
          delete out.provider;
          delete out.response_format;
          return out;
        },
        fetch: async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url !== COMMAND_CODE_BASE_URL + "/chat/completions" || init?.method !== "POST" || typeof init.body !== "string")
            throw new LibraryError("unavailable", "This Command Code endpoint is not supported.", 503);
          init.signal?.throwIfAborted();
          const headers = { "Content-Type": "application/json", "x-session-affinity": sessionAffinity,
            "cf-aig-no-wholesale": "true", "cf-aig-max-attempts": "1", "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false" };
          // Native binding mechanism: Agents 0.30.1, packages/agents/src/models/core/transport.ts.
          // Ai.fetch is not declared in the pinned types; preserve its receiver with this narrow cast.
          return (env.AI as unknown as Pick<Fetcher, "fetch">).fetch(
            'https://workers-binding.ai/ai-gateway/gateways/' + encodeURIComponent(gatewayId) + '/custom-command-code/v1/chat/completions',
            { method: "POST", body: init.body, headers, ...(init.signal ? { signal: init.signal } : {}) });
        },
      }).languageModel(model.id);
    }
    const structured = model.structuredOutputs === true;
    const openrouter = createOpenAICompatible<string, string, string, string>({
      name: "openrouter",
      baseURL: OPENROUTER_BASE_URL,
      includeUsage: true,
      supportsStructuredOutputs: structured,
      transformRequestBody: openRouterBody(structured, model.reasoning),
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
      gateway: { id: connection.gatewayId, skipCache: true, collectLog: false, retries: { maxAttempts: 1 } },
      vendorKey: "gateway",
    });
  }
  if (model.route.startsWith("workers-ai:")) {
    return createAI({ binding: env.AI }).languageModel(model.id, { ...(model.nativeReasoningEffort ? { reasoningEffort: model.nativeReasoningEffort } : {}), sessionAffinity });
  }
  throw new LibraryError("unavailable", "This model route is not supported.", 503);
}

export function modelFailure(error: unknown, model: ModelSpec): string {
  if (!model.route.startsWith("gateway:")) {
    return error instanceof Error ? (error.name + ": " + error.message).slice(0, 300) : NATIVE_FAILURE;
  }
  const status = errorStatusCode(error);
  if (status !== undefined) {
    return "External model request failed (HTTP " + status + "). Check the Gateway connection and provider status; no retry was started.";
  }
  const cause = errorCauseName(error);
  if (cause !== undefined) {
    return "External model request failed (cause: " + cause + "). Check the Gateway connection and provider status; no retry was started.";
  }
  return EXTERNAL_FAILURE;
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

function errorCauseName(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (error instanceof Error && error.name === "AI_NoObjectGeneratedError" && cause instanceof Error && cause.name === "AI_JSONParseError") return "AI_JSONParseError";
  const names = ["Error", "TypeError", "AbortError", "TimeoutError", "AI_APICallError", "AI_StreamProviderError", "AI_NoObjectGeneratedError", "AI_NoOutputGeneratedError", "AI_InvalidResponseDataError", "AI_TypeValidationError", "AiGatewayError", "AiError", "ZodError"];
  return cause instanceof Error && names.includes(cause.name) ? cause.name : undefined;
}
