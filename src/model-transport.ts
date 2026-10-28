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
// paid fallback and require declared parameters. responseFormatAllowed means the
// catalog entry explicitly allows a response_format field (json_object for
// non-schema models); otherwise the vendor-emitted field is stripped because the
// provider contract forbids it. The caller adds the explicit schema instruction
// when model.responseFormat is false; Output.object parses locally either way
// and failures stay local with no repair calls.
// Generic compatible body for the native gateway fetch: no provider routing hint;
// strip response_format unless the catalog explicitly advertises it. Structured
// output is enabled only when the catalog sets structuredOutputs; otherwise the
// caller codec handles plain JSON locally.
function compatibleBody(responseFormatAllowed: boolean) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...args };
    delete out.provider;
    if (!responseFormatAllowed) delete out.response_format;
    return out;
  };
}
function openRouterBody(responseFormatAllowed: boolean) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const provider = { ...(args.provider as Record<string, unknown> | undefined), allow_fallbacks: false, require_parameters: true };
    const out: Record<string, unknown> = { ...args, provider };
    if (!responseFormatAllowed) delete out.response_format;
    return out;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export async function resolveModelTransport(
  env: Pick<Env, "AI" | "DB">,
  model: ModelSpec,
  sessionAffinity: string,
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
    const openrouter = createOpenAICompatible<string, string, string, string>({
      name: "openrouter",
      baseURL: provider.baseUrl,
      includeUsage: true,
      supportsStructuredOutputs: structured,
      transformRequestBody: openRouterBody(responseFormatAllowed),
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
  return createOpenAICompatible({
    name: provider.id, baseURL, includeUsage: true,
    supportsStructuredOutputs: structured, convertUsage: convertCompatibleUsage,
    transformRequestBody: baseURL === OFFICIAL_OPENROUTER_BASE_URL ? openRouterBody(responseFormatAllowed) : compatibleBody(responseFormatAllowed),
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
  if (!model.route.startsWith("gateway:")) {
    const status = errorStatusCode(error);
    if (status !== undefined) return `Model stream failed (HTTP ${status}).`;
    // Preserve the safe per-question validation category in the existing text
    // format: predispatch AI_Invalid* (allowlisted names above) and in-band
    // invalid_request_error. No message/body/secrets are echoed.
    const directValidationStream = streamProviderErrorNames(error)[0];
    const causedValidationStream = streamProviderErrorNames(error instanceof Error ? error.cause : undefined)[0];
    const validationStream = directValidationStream === "AI_StreamProviderError:invalid_request_error"
      ? directValidationStream
      : causedValidationStream === "AI_StreamProviderError:invalid_request_error" ? causedValidationStream : undefined;
    const name = validationStream ?? knownErrorName(error) ?? (error instanceof Error ? knownErrorName(error.cause) : undefined);
    return name === undefined ? NATIVE_FAILURE : `Model stream failed (${name}).`;
  }
  const status = errorStatusCode(error);
  if (status !== undefined) {
    const hint = status === 400 ? validationFieldHint(error) : "";
    return "External model request failed (HTTP " + status + "). Check the Gateway connection and provider status; no retry was started." + hint;
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

const KNOWN_ERROR_NAMES = ["Error", "TypeError", "AbortError", "TimeoutError", "AI_APICallError",
  "AI_StreamProviderError", "AI_InvalidPromptError", "AI_InvalidArgumentError", "AI_NoObjectGeneratedError", "AI_NoOutputGeneratedError", "AI_InvalidResponseDataError",
  "AI_TypeValidationError", "AiGatewayError", "AiError", "ZodError"] as const;

function knownErrorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return (KNOWN_ERROR_NAMES as readonly string[]).includes(error.name) ? error.name : undefined;
}

// The shared projection for operator logs. Keep only allowlisted names and a
// validated HTTP status; provider messages, bodies, codes and request data stay private.
export function safeErrorLogProjection(error: unknown): { name: string; status?: number } {
  const name = knownErrorName(error) ?? (error instanceof Error ? knownErrorName(error.cause) : undefined);
  const status = errorStatusCode(error);
  return { name: name ?? "unknown", ...(status === undefined ? {} : { status }) };
}

// Minimal 400-only validation hint: report only fixed OpenAI request field
// names that literally appear in the provider error's param/message. Never
// include raw message/body text, codes, types, keys, headers, data or prompt.
const VALIDATION_FIELDS = ["messages", "role", "content", "reasoning_content",
  "reasoning_details", "thought_signature", "max_tokens", "response_format", "stream_options"] as const;

function validationFieldHint(error: unknown): string {
  const seen: string[] = [];
  const haystacks: string[] = [];
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) haystacks.push(value.slice(0, 8192));
  };
  const err = error as { data?: unknown; responseBody?: unknown } | null | undefined;
  pushText(err?.responseBody);
  const data = err?.data;
  if (typeof data === "string") pushText(data);
  else if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    pushText(record.param);
    pushText(record.message);
    const nested = record.error;
    if (nested !== null && typeof nested === "object") {
      const inner = nested as Record<string, unknown>;
      pushText(inner.param);
      pushText(inner.message);
    }
  }
  if (error instanceof Error) pushText(error.message);
  for (const field of VALIDATION_FIELDS) {
    const token = '"' + field + '"';
    const bare = new RegExp("(^|[^a-zA-Z0-9_])" + field + "([^a-zA-Z0-9_]|$)");
    if (haystacks.some((text) => text.includes(token) || bare.test(text))) seen.push(field);
  }
  return seen.length > 0 ? " Validation mentions fields: " + seen.join(", ") + "." : "";
}

function errorCauseName(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (error instanceof Error && error.name === "AI_NoObjectGeneratedError" && cause instanceof Error && cause.name === "AI_JSONParseError") return "AI_JSONParseError";
  const directStreamError = streamProviderErrorNames(error)[0];
  if (directStreamError) return directStreamError;
  const causedStreamError = streamProviderErrorNames(cause)[0];
  if (causedStreamError) return causedStreamError;
  // Preserve predispatch validation in the existing cause format when the
  // top-level error itself carries it; cause-only lookup would strip it.
  if (error instanceof Error && (error.name === "AI_InvalidPromptError" || error.name === "AI_InvalidArgumentError")) return error.name;
  return knownErrorName(cause);
}

// Pinned @ai-sdk/openai-compatible 3.0.79 streams a mid-stream provider error
// as the raw `{ error: { message, type?, code? } }` chunk payload with no HTTP
// status attached. Surface only the standard SDK error name plus a fixed
// OpenAI error-type allowlist; never echo raw message/body, keys or codes.
const STREAM_ERROR_TYPES = ["invalid_request_error", "authentication_error",
  "permission_error", "not_found_error", "rate_limit_error", "server_error",
  "overloaded_error", "timeout_error", "invalid_response_error"] as const;

function streamProviderErrorNames(error: unknown): string[] {
  if (!(error instanceof Error) || error.name !== "AI_StreamProviderError") return [];
  const data = (error as { data?: unknown }).data;
  const nested = isRecord(data) && isRecord(data.error) ? data.error : data;
  if (!isRecord(nested)) return ["AI_StreamProviderError"];
  const record = nested;
  const type = typeof record.type === "string" ? record.type : undefined;
  if (type !== undefined && (STREAM_ERROR_TYPES as readonly string[]).includes(type)) return ["AI_StreamProviderError:" + type];
  return ["AI_StreamProviderError"];
}
