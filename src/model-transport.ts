import { createAI } from "agents/models/ai-sdk";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware, type LanguageModelUsage } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import { LibraryError } from "./library";
import { isProviderApiBase, type ModelProvider, type ModelSpec } from "./models";
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
export function reportedProviderUsage(usage: LanguageModelUsage): ProviderUsage | null {
  const raw = usage.raw;
  if (!raw) return null;
  const input = raw.prompt_tokens_details, output = raw.completion_tokens_details;
  const cached = input && typeof input === "object" && "cached_tokens" in input ? input.cached_tokens : undefined;
  const reasoning = output && typeof output === "object" && "reasoning_tokens" in output ? output.reasoning_tokens : undefined;
  return { inputTokens: count(raw.prompt_tokens) ?? null, outputTokens: count(raw.completion_tokens) ?? null,
    totalTokens: count(raw.total_tokens) ?? null, cachedTokens: count(cached) ?? null, reasoningTokens: count(reasoning) ?? null };
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
    const provider = { ...(args.provider as Record<string, unknown> | undefined), allow_fallbacks: false, require_parameters: true, data_collection: "deny" };
    const out: Record<string, unknown> = { ...args, provider };
    if (!responseFormatAllowed) delete out.response_format;
    if (options.supportsTemperature) out.temperature = 0;
    if (options.structuredOutput && options.optionalReasoning) out.reasoning = { enabled: false };
    return out;
  };
}

type GatewayProtocolFetchOptions = {
  rootBase: string;
  ownerBase: string;
  gatewayBase: string;
  sessionAffinity: string;
  preserveAnthropicHeaders: boolean;
};

const STRIPPED_QUERY_NAMES = new Set(["key", "apikey", "api_key", "x-goog-api-key", "x-goog-api_key"]);

function normalizedBase(value: string): string {
  return value.replace(/\/+$/, "");
}

// Frozen Gateway custom route without the vendor protocol path. The per-request
// vendor path relative to the published owner API base is appended, so one
// custom slug serves every protocol beneath the approved root.
function gatewayBaseFor(provider: Pick<ModelProvider, "gatewaySlug" | "gatewayPath">, gatewayId: string): string {
  const path = provider.gatewayPath ? `/${provider.gatewayPath}` : "";
  return `https://workers-binding.ai/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/${provider.gatewaySlug}${path}`;
}

// Provider-native SDK fetch through the pinned Agents AI.fetch adapter. The SDK
// builds the vendor URL, method, raw body and signal; this wrapper only moves
// the vendor-relative path onto the frozen Gateway custom route, keeps
// protocol-safe headers (Anthropic version/beta, Google alt=sse query) and
// drops vendor credentials before the Gateway. Gateway default BYOK supplies
// credentials; the wrapper starts no retry and keeps raw native IDs untouched.
function createProtocolFetch(env: Pick<Env, "AI">, opts: GatewayProtocolFetchOptions) {
  const root = new URL(normalizedBase(opts.rootBase));
  const rootPath = root.pathname.replace(/\/+$/, "") || "/";
  const owner = new URL(normalizedBase(opts.ownerBase));
  const ownerPath = owner.pathname.replace(/\/+$/, "") || "/";
  const gatewayBase = normalizedBase(opts.gatewayBase);
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const vendorRaw = input instanceof Request ? input.url : String(input);
    let vendor: URL;
    try {
      vendor = new URL(vendorRaw);
    } catch {
      throw new LibraryError("unavailable", "This provider endpoint is not supported.", 503);
    }
    if (vendor.protocol !== "https:" || vendor.origin !== owner.origin) {
      throw new LibraryError("unavailable", "This provider endpoint is not supported.", 503);
    }
    const under = ownerPath === "/" || vendor.pathname === ownerPath || vendor.pathname.startsWith(ownerPath + "/");
    if (!under) {
      throw new LibraryError("unavailable", "This provider endpoint is not supported.", 503);
    }
    if (init?.method !== "POST" || typeof init.body !== "string") {
      throw new LibraryError("unavailable", "This provider endpoint is not supported.", 503);
    }
    init.signal?.throwIfAborted();
    // Gateway custom routes mirror the vendor path beneath the approved provider
    // root (legacy Command Code precedent: root /provider/v1 plus gatewayPath
    // v1 yields slug/v1/chat/completions). The owner protocol base only bounds
    // validation; the Gateway keeps the full protocol subpath.
    const underRoot = rootPath === "/" || vendor.pathname === rootPath || vendor.pathname.startsWith(rootPath + "/");
    if (!underRoot) {
      throw new LibraryError("unavailable", "This provider endpoint is not supported.", 503);
    }
    const relative = rootPath === "/" ? vendor.pathname : vendor.pathname.slice(rootPath.length) || "/";
    const params = new URLSearchParams(vendor.search);
    for (const name of [...params.keys()]) {
      if (STRIPPED_QUERY_NAMES.has(name.toLowerCase())) params.delete(name);
    }
    const query = params.toString();
    const gatewayUrl = gatewayBase + relative + (query ? `?${query}` : "");
    const incoming = new Headers(init?.headers);
    const headers: Record<string, string> = {
      "Content-Type": incoming.get("content-type") ?? "application/json",
      "x-session-affinity": opts.sessionAffinity,
      "cf-aig-no-wholesale": "true",
      "cf-aig-max-attempts": "1",
      "cf-aig-skip-cache": "true",
      "cf-aig-collect-log": "false",
    };
    if (opts.preserveAnthropicHeaders) {
      for (const name of ["anthropic-version", "anthropic-beta"] as const) {
        const value = incoming.get(name);
        if (value !== null) headers[name] = value;
      }
    }
    // Native binding mechanism: Agents 0.30.1, packages/agents/src/models/core/transport.ts.
    // Ai.fetch is not declared in the pinned types; preserve its receiver with this narrow cast.
    return (env.AI as unknown as Pick<Fetcher, "fetch">).fetch(gatewayUrl, {
      method: "POST",
      body: init.body,
      headers,
      ...(init.signal ? { signal: init.signal } : {}),
    });
  };
}

// Responses entries never persist server state through this transport: every
// call stores nothing and carries no prior response or conversation binding.
const responsesStatelessMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    providerOptions: {
      ...params.providerOptions,
      openai: {
        ...params.providerOptions?.openai,
        store: false,
        previousResponseId: undefined,
        conversation: undefined,
      },
    },
  }),
};

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
  // Published protocol selection from catalogue metadata. The branch is the
  // catalogue's apiProtocol only; no model-name allowlist or registry here.
  // Undefined keeps the legacy provider-base Chat path below untouched.
  const apiProtocol = model.apiProtocol;
  if (apiProtocol !== undefined) {
    if (model.apiBaseUrl === undefined || !isProviderApiBase(provider, model.apiBaseUrl)) {
      throw new LibraryError("unavailable", "This model route is not supported.", 503);
    }
    const ownerBase = normalizedBase(model.apiBaseUrl);
    const protocolGatewayBase = gatewayBaseFor(provider, gatewayId);
    if (apiProtocol === "openai-chat") {
      const responseFormatAllowed = model.responseFormat === true;
      const supportsTemperature = model.supportsTemperature === true;
      return createOpenAICompatible({
        name: provider.id,
        baseURL: ownerBase,
        includeUsage: true,
        supportsStructuredOutputs: model.structuredOutputs === true,
        convertUsage: convertCompatibleUsage,
        transformRequestBody:
          ownerBase === OFFICIAL_OPENROUTER_BASE_URL
            ? openRouterBody(responseFormatAllowed, { supportsTemperature, optionalReasoning: model.optionalReasoning === true, structuredOutput: options.structuredOutput === true })
            : compatibleBody(responseFormatAllowed, supportsTemperature),
        fetch: createProtocolFetch(env, { rootBase: normalizedBase(provider.baseUrl ?? ""), ownerBase, gatewayBase: protocolGatewayBase, sessionAffinity, preserveAnthropicHeaders: false }),
      }).languageModel(model.id);
    }
    if (apiProtocol === "openai-responses") {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const inner = createOpenAI({ baseURL: ownerBase, apiKey: "", fetch: createProtocolFetch(env, { rootBase: normalizedBase(provider.baseUrl ?? ""), ownerBase, gatewayBase: protocolGatewayBase, sessionAffinity, preserveAnthropicHeaders: false }), name: provider.id }).responses(model.id);
      return wrapLanguageModel({ model: inner, middleware: responsesStatelessMiddleware });
    }
    if (apiProtocol === "anthropic") {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ baseURL: ownerBase, apiKey: "", fetch: createProtocolFetch(env, { rootBase: normalizedBase(provider.baseUrl ?? ""), ownerBase, gatewayBase: protocolGatewayBase, sessionAffinity, preserveAnthropicHeaders: true }), name: provider.id }).languageModel(model.id);
    }
    const { createGoogle } = await import("@ai-sdk/google");
    return createGoogle({ baseURL: ownerBase, apiKey: "", fetch: createProtocolFetch(env, { rootBase: normalizedBase(provider.baseUrl ?? ""), ownerBase, gatewayBase: protocolGatewayBase, sessionAffinity, preserveAnthropicHeaders: false }), name: provider.id }).languageModel(model.id);
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

// Bounded limit signals only. Native Workers AI code 3036 means the daily free
// allocation is exhausted and resets at the next 00:00 UTC. Gateway HTTP 429
// uses only validated retry timing from the typed response headers, otherwise
// reset unknown; no provider-wide reset is invented and no other code or
// status gains limit wording. Raw bodies, headers and secrets are never echoed.
function isNativeDailyLimit(error: unknown): boolean {
  const codes = [
    (error as { code?: unknown } | null | undefined)?.code,
    error instanceof Error ? (error.cause as { code?: unknown } | null | undefined)?.code : undefined,
  ];
  return codes.some((code) => code === 3036);
}

function typedResponseHeaders(error: unknown): Record<string, string> | undefined {
  const candidates = [
    (error as { responseHeaders?: unknown } | null | undefined)?.responseHeaders,
    error instanceof Error ? (error.cause as { responseHeaders?: unknown } | null | undefined)?.responseHeaders : undefined,
  ];
  for (const headers of candidates) {
    if (headers !== null && typeof headers === "object" && !Array.isArray(headers)) return headers as Record<string, string>;
  }
  return undefined;
}

function gatewayRetryAfterSeconds(error: unknown): number | undefined {
  const headers = typedResponseHeaders(error);
  if (!headers) return undefined;
  const lowered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") lowered[key.toLowerCase()] = value;
  }
  const ms = lowered["retry-after-ms"];
  if (ms !== undefined) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 86_400_000) return Math.ceil(parsed / 1000);
    return undefined;
  }
  const raw = lowered["retry-after"];
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86400) return seconds;
    return undefined;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  const seconds = Math.ceil((at - Date.now()) / 1000);
  return seconds >= 0 && seconds <= 86400 ? seconds : undefined;
}

const NO_ENDPOINT_DATA_POLICY_REASON =
  "External model request failed (HTTP 404). Provider reports no endpoint matching its data policy. Review provider privacy settings or choose another model. No retry was started.";

function isNoEndpointDataPolicy(error: unknown): boolean {
  const bodies = [
    (error as { responseBody?: unknown } | null | undefined)?.responseBody,
    error instanceof Error ? (error.cause as { responseBody?: unknown } | null | undefined)?.responseBody : undefined,
  ];
  for (const body of bodies) {
    if (typeof body !== "string" || body.length === 0 || body.length > 4096) continue;
    let message: unknown;
    try {
      message = (JSON.parse(body) as { error?: { message?: unknown } | null } | null)?.error?.message;
    } catch {
      continue;
    }
    if (typeof message !== "string") continue;
    if (/^no endpoints found (?:that match|matching) your data policy\b/i.test(message)) return true;
  }
  return false;
}

export function modelFailure(error: unknown, model: ModelSpec): string {
  const status = errorStatusCode(error);
  if (model.route.startsWith("gateway:")) {
    if (status === 429) {
      const wait = gatewayRetryAfterSeconds(error);
      const reset = wait === undefined ? "reset unknown" : "retry after " + wait + "s";
      return "External model request failed (HTTP 429). Limit exhausted, " + reset + ". No retry was started.";
    }
    if (status === 404 && isNoEndpointDataPolicy(error)) {
      return NO_ENDPOINT_DATA_POLICY_REASON;
    }
    if (status !== undefined) {
      return "External model request failed (HTTP " + status + "). Check the Gateway connection and provider status; no retry was started.";
    }
    return EXTERNAL_FAILURE;
  }
  if (isNativeDailyLimit(error)) {
    return "Model stream failed. Daily limit exhausted, resets at 00:00 UTC. No retry was started.";
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
