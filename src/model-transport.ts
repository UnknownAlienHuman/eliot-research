import { createAI } from "agents/models/ai-sdk";
import type { LanguageModel } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import { LibraryError } from "./library";
import { getModelConnection, type ModelSpec } from "./models";

const OPENROUTER_PREFIX = "gateway:openrouter/";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const EXTERNAL_FAILURE =
  "External model request failed. Check the Gateway connection and provider status; no retry was started.";
const NATIVE_FAILURE = "Model stream failed.";

type ProviderConvertUsage = NonNullable<OpenAICompatibleProviderSettings["convertUsage"]>;

function count(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// Narrow OpenRouter usage fix (pinned @ai-sdk/openai-compatible 3.0.79): the bundled
// converter coerces missing counts to 0, which wrongly settles usage as zero on priced
// routes. Unknown stays unknown here; output follows the same max(completion,
// total - prompt) rule as the native path and never subtracts reasoning (OpenRouter
// completion totals already include it). Contradictory detail counts reset to unknown,
// and a total below prompt or reasoning above the computed output keeps output unknown
// so the reservation is retained instead of billing an inconsistent number.
const convertOpenRouterUsage: ProviderConvertUsage = (usage) => {
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
function openRouterBody(structured: boolean) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const provider = { ...(args.provider as Record<string, unknown> | undefined), allow_fallbacks: false, require_parameters: true };
    if (structured) return { ...args, provider };
    const out: Record<string, unknown> = { ...args, provider };
    delete out.response_format;
    return out;
  };
}

export async function resolveModelTransport(
  env: Pick<Env, "AI" | "DB">,
  model: ModelSpec,
  sessionAffinity: string,
): Promise<LanguageModel> {
  if (model.route.startsWith(OPENROUTER_PREFIX)) {
    if (model.route !== OPENROUTER_PREFIX + model.id) {
      throw new LibraryError("unavailable", "This model route is not supported.", 503);
    }
    const connection = await getModelConnection(env);
    if (!connection.gatewayId) {
      throw new LibraryError("unavailable",
        "External models are disconnected. Allow access to the existing Gateway credential in Settings first.", 503);
    }
    const structured = model.structuredOutputs === true;
    const openrouter = createOpenAICompatible<string, string, string, string>({
      name: "openrouter",
      baseURL: OPENROUTER_BASE_URL,
      includeUsage: true,
      supportsStructuredOutputs: structured,
      transformRequestBody: openRouterBody(structured),
      convertUsage: convertOpenRouterUsage,
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
    return createAI({ binding: env.AI }).languageModel(model.id, { reasoningEffort: "low", sessionAffinity });
  }
  throw new LibraryError("unavailable", "This model route is not supported.", 503);
}

export function modelFailure(error: unknown, model: ModelSpec): string {
  if (!model.route.startsWith("gateway:")) {
    return error instanceof Error ? (error.name + ": " + error.message).slice(0, 300) : NATIVE_FAILURE;
  }
  return EXTERNAL_FAILURE;
}
