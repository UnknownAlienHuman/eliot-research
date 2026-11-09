import { createAI } from "agents/models/ai-sdk";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware, type LanguageModelUsage } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import { LibraryError } from "./library";
import { isProviderApiBase, type ModelProvider, type ModelSpec } from "./models";
import { isKiloApiBase, isOpenRouterApiBase, type DataCollectionPolicy, type ProviderUsage } from "./shared/api";
import { validateSourceUrl } from "./url-guard";

const EXTERNAL_FAILURE =
  "External model request failed. Check the Gateway connection and provider status; no retry was started.";
const NATIVE_FAILURE = "Model stream failed.";

type ProviderConvertUsage = NonNullable<OpenAICompatibleProviderSettings["convertUsage"]>;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isNativeOpenRouterRoute(model?: Pick<ModelSpec, "route" | "routing">): boolean {
  const provider = model?.routing?.provider;
  return provider?.gatewaySlug === "openrouter" && provider?.gatewayPath === "v1" && isOpenRouterApiBase(provider?.baseUrl);
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
// catalog entry explicitly allows response_format; full schema also requires
// structuredOutputs === true. Otherwise the caller adds the exact schema in
// instructions, including when either capability is unknown. Output.object
// parses locally in both schema and JSON-object/text fallback modes,
// and failures stay local with no repair calls.
// Temperature 0 is app strategy for determinism within the published 0-2 range
// (official OpenRouter ChatRequest), sent only when the catalogue advertises
// "temperature"; otherwise omitted so provider defaults apply (no fake defaults).
// Structured-output reasoning off is bounded-output recovery: when the Workflow
// passes structuredOutput:true and the catalogue publishes optionalReasoning
// (reasoning.mandatory === false plus advertised "reasoning"), the official
// OpenRouter body sends reasoning:{enabled:false} (documented ReasoningConfig).
// Never for chat (structuredOutput false), natively mandatory, or unknown.
// Kilo's separately verified paired OFF profile uses the compatible body.
// Generic compatible body for the native gateway fetch: no provider routing hint;
// strip response_format unless the catalog explicitly advertises it. Structured
// output is enabled only when the catalog sets structuredOutputs; otherwise the
// caller codec handles plain JSON locally.
function compatibleBody(responseFormatAllowed: boolean, supportsTemperature: boolean, kiloReasoningOff = false) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...args };
    delete out.provider;
    if (!responseFormatAllowed) delete out.response_format;
    if (supportsTemperature) out.temperature = 0;
    if (kiloReasoningOff) out.reasoning = { enabled: false, effort: "none" };
    return out;
  };
}
function openRouterBody(responseFormatAllowed: boolean, options: { supportsTemperature: boolean; optionalReasoning: boolean; structuredOutput: boolean; structuredReasoningEffort?: ModelSpec["structuredReasoningEffort"]; openRouterReasoningEffort?: string | undefined; freshChatMinimal: boolean }, dataCollection: DataCollectionPolicy) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const provider = { ...(args.provider as Record<string, unknown> | undefined), allow_fallbacks: false, require_parameters: true, data_collection: dataCollection };
    const out: Record<string, unknown> = { ...args, provider };
    if (!responseFormatAllowed) delete out.response_format;
    if (options.supportsTemperature) out.temperature = 0;
    // An admitted owner choice precedes automatic profiles for structured jobs.
    // Without it, mutually inconsistent automatic flags stay unset (fail closed).
    if (options.structuredOutput && options.openRouterReasoningEffort !== undefined) out.reasoning = { effort: options.openRouterReasoningEffort };
    else if (options.structuredOutput && options.structuredReasoningEffort === "minimal" && !options.optionalReasoning) out.reasoning = { effort: "minimal" };
    else if (options.structuredOutput && options.optionalReasoning && options.structuredReasoningEffort === undefined) out.reasoning = { enabled: false };
    else if (!options.structuredOutput && options.freshChatMinimal) out.reasoning = { effort: "minimal" };
    return out;
  };
}

type GatewayProtocolFetchOptions = {
  rootBase: string;
  ownerBase: string;
  gatewayBase?: string | undefined;
  anonymous?: boolean;
  onResponseBytes?: ((bytes: number) => void) | undefined;
  sessionAffinity: string;
  keyAlias?: string | undefined;
  preserveAnthropicHeaders: boolean;
};

const STRIPPED_QUERY_NAMES = new Set(["key", "apikey", "api_key", "x-goog-api-key", "x-goog-api_key"]);
const ANONYMOUS_RESPONSE_BYTES = 16 * 1024 * 1024; // Product wire-envelope bound, separate from model/token capacity.
const ANONYMOUS_RESPONSE_LIMIT_REASON = "Anonymous response exceeded the 16 MiB wire-envelope bound. No retry was started.";

function normalizedBase(value: string): string {
  return value.replace(/\/+$/, "");
}
function isOpenCodeGoRoot(url: URL): boolean {
  return url.origin === "https://opencode.ai" &&
    (url.pathname === "/inference/go" || url.pathname.startsWith("/inference/go/"));
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
// drops vendor credentials before the Gateway. Gateway-selected BYOK supplies
// credentials; the wrapper starts no retry and keeps raw native IDs untouched.
function createProtocolFetch(env: Partial<Pick<Env, "AI">>, opts: GatewayProtocolFetchOptions) {
  const root = new URL(normalizedBase(opts.rootBase));
  const rootPath = root.pathname.replace(/\/+$/, "") || "/";
  const owner = new URL(normalizedBase(opts.ownerBase));
  const ownerPath = owner.pathname.replace(/\/+$/, "") || "/";
  const gatewayBase = normalizedBase(opts.gatewayBase ?? "");
  if (opts.anonymous) { validateSourceUrl(root.href); validateSourceUrl(owner.href); }
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
    if (opts.anonymous) validateSourceUrl(vendor.href);
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
      if (opts.anonymous ? name !== "alt" || params.get(name) !== "sse" : STRIPPED_QUERY_NAMES.has(name.toLowerCase())) params.delete(name);
    }
    const query = params.toString();
    const gatewayUrl = gatewayBase + relative + (query ? `?${query}` : "");
    const incoming = new Headers(init?.headers);
    const headers: Record<string, string> = {
      "Content-Type": incoming.get("content-type") ?? "application/json",
      "x-session-affinity": opts.sessionAffinity,
      "user-agent": "EliotResearch/0.1.0",
      ...(isOpenCodeGoRoot(root) ? { "x-opencode-session": opts.sessionAffinity } : {}),
      ...(opts.anonymous ? {} : {
        ...(opts.keyAlias === undefined ? {} : { "cf-aig-byok-alias": opts.keyAlias }),
        "cf-aig-no-wholesale": "true", "cf-aig-max-attempts": "1", "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false",
      }),
    };
    if (opts.preserveAnthropicHeaders) {
      for (const name of ["anthropic-version", "anthropic-beta"] as const) {
        const value = incoming.get(name);
        if (value !== null) headers[name] = value;
      }
    }
    if (opts.anonymous) {
      const signal = init.signal;
      if (!signal) throw new LibraryError("invalid", "Anonymous requests require the caller's abort signal.", 400);
      const target = vendor.origin + vendor.pathname + (query ? `?${query}` : "");
      const response = await fetch(target, { method: "POST", body: init.body, headers, credentials: "omit", redirect: "manual", signal });
      const fail = () => new LibraryError("invalid", ANONYMOUS_RESPONSE_LIMIT_REASON, 400);
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => undefined);
        throw new LibraryError("unavailable", "Anonymous provider redirect was rejected. No retry was started.", 503);
      }
      const length = Number(response.headers.get("content-length"));
      if (Number.isSafeInteger(length) && length > ANONYMOUS_RESPONSE_BYTES) { void response.body?.cancel().catch(() => undefined); throw fail(); }
      if (!response.body) return response;
      const reader = response.body.getReader();
      let used = 0;
      const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const part = await reader.read();
            signal.throwIfAborted();
            if (part.done) { signal.removeEventListener("abort", abort); controller.close(); return; }
            if (part.value.byteLength > ANONYMOUS_RESPONSE_BYTES - used) throw fail();
            opts.onResponseBytes?.(part.value.byteLength);
            used += part.value.byteLength;
            controller.enqueue(part.value);
          } catch (error) {
            signal.removeEventListener("abort", abort);
            void reader.cancel(error).catch(() => undefined);
            controller.error(error);
          }
        },
        cancel(reason) { signal.removeEventListener("abort", abort); return reader.cancel(reason); },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    // Native binding mechanism: Agents 0.30.1, packages/agents/src/models/core/transport.ts.
    // Ai.fetch is not declared in the pinned types; preserve its receiver with this narrow cast.
    return (env.AI as unknown as Pick<Fetcher, "fetch">).fetch(gatewayUrl, {
      method: "POST",
      redirect: "manual",
      body: init.body,
      headers,
      ...(init.signal ? { signal: init.signal } : {}),
    });
  };
}

// Responses entries never persist server state through this transport: every
// call stores nothing and carries no prior response or conversation binding.
const responsesStatelessMiddleware = (supportsReasoning: boolean | undefined): LanguageModelMiddleware => ({
  transformParams: async ({ params }) => ({
    ...params,
    providerOptions: {
      ...params.providerOptions,
      openai: {
        ...params.providerOptions?.openai,
        ...(supportsReasoning === true ? { forceReasoning: true } : {}),
        store: false,
        previousResponseId: undefined,
        conversation: undefined,
      },
    },
  }),
});

export async function resolveModelTransport(
  env: Pick<Env, "DB"> & Partial<Pick<Env, "AI">>,
  model: ModelSpec,
  sessionAffinity: string,
  options: { structuredOutput?: boolean; freshChat?: boolean; onResponseBytes?: (bytes: number) => void } = {},
): Promise<LanguageModel> {
  if (model.route.startsWith("workers-ai:")) {
    if (model.routing?.provider.keyAlias !== undefined || model.routing?.provider.authMode !== undefined) throw new LibraryError("invalid", "Workers AI does not use external authentication settings.", 400);
    if (!env.AI) throw new LibraryError("unavailable", "Workers AI binding is unavailable.", 503);
    const native = createAI({ binding: env.AI }).languageModel(model.id, { ...(model.nativeReasoningEffort ? { reasoningEffort: model.nativeReasoningEffort } : {}), sessionAffinity });
    return options.structuredOutput === true ? wrapLanguageModel({ model: native, middleware: {
      transformParams: async ({ params, type }) => type === "stream" ? { ...params, responseFormat: { type: "text" } } : params,
    } }) : native;
  }
  if (!model.route.startsWith("gateway:")) {
    throw new LibraryError("unavailable", "This model route is not supported.", 503);
  }
  const routing = model.routing;
  if (!routing || !routing.provider) {
    throw new LibraryError("unavailable", "This model route is not supported.", 503);
  }
  const provider = routing.provider;
  const anonymous = provider.authMode === "anonymous";
  if (anonymous && options.structuredOutput && !options.onResponseBytes)
    throw new LibraryError("invalid", "Anonymous structured calls require the operation materialization counter.", 400);
  const gatewayId = routing.gatewayId ?? ""; // Unused for anonymous; the frozen field remains null.
  if (provider.authMode !== undefined && provider.authMode !== "gateway" && !anonymous)
    throw new LibraryError("unavailable", "The authentication mode is unsupported.", 503);
  if (anonymous ? routing.gatewayId !== null || provider.keyAlias !== undefined
    : !env.AI || !gatewayId || gatewayId === "default" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(gatewayId))
    throw new LibraryError("unavailable", "The provider connection is unavailable.", 503);
  if (provider.type !== "openai-compatible" || !provider.enabled) {
    throw new LibraryError("unavailable", "This model route is not supported.", 503);
  }
  // Frozen route: exact gateway:<provider.id>/<model.id> for every compatible provider.
  if (!model.id.trim() || model.route !== `gateway:${provider.id}/${model.id}`) {
    throw new LibraryError("unavailable", "This model route is not supported.", 503);
  }
  if (!provider.baseUrl || (!anonymous && !provider.gatewaySlug)) {
    throw new LibraryError("unavailable", "This model route is not supported.", 503);
  }
  // The marker carries explicit mandatory discovery evidence; absence of optional reasoning alone is insufficient.
  const freshChatMinimal = options.freshChat === true && isOpenRouterApiBase(provider.baseUrl) &&
    model.structuredReasoningEffort === "minimal" && model.optionalReasoning !== true &&
    Array.isArray(model.openRouterReasoningEfforts) && model.openRouterReasoningEfforts.includes("minimal");
  const kiloReasoningOff = options.structuredOutput === true && isKiloApiBase(provider.baseUrl)
    && model.optionalReasoning === true && model.structuredReasoningEffort === "none";
  if (!anonymous && isNativeOpenRouterRoute(model)) {
    if (!env.AI) throw new LibraryError("unavailable", "The Gateway binding is unavailable.", 503);
    const structured = model.structuredOutputs === true;
    const responseFormatAllowed = model.responseFormat === true;
    const transportOptions = {
      supportsTemperature: model.supportsTemperature === true,
      optionalReasoning: model.optionalReasoning === true,
      structuredOutput: options.structuredOutput === true,
      structuredReasoningEffort: model.structuredReasoningEffort,
      openRouterReasoningEffort: model.openRouterReasoningEffort,
      freshChatMinimal,
    };
    const openrouter = createOpenAICompatible<string, string, string, string>({
      name: "openrouter",
      baseURL: provider.baseUrl,
      includeUsage: true,
      supportsStructuredOutputs: structured,
      transformRequestBody: openRouterBody(responseFormatAllowed, transportOptions, provider.dataCollection ?? "deny"),
      convertUsage: convertCompatibleUsage,
    });
    const vendor = openrouter.languageModel(model.id);
    return createAI({ binding: env.AI }).languageModel(vendor, {
      sessionAffinity,
      headers: {
        "user-agent": "EliotResearch/0.1.0",
        ...(provider.keyAlias === undefined ? {} : { "cf-aig-byok-alias": provider.keyAlias }),
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
    const protocolGatewayBase = anonymous ? undefined : gatewayBaseFor(provider, gatewayId);
    const protocolFetch = createProtocolFetch(env, { rootBase: normalizedBase(provider.baseUrl), ownerBase,
      gatewayBase: protocolGatewayBase, anonymous, onResponseBytes: options.onResponseBytes, sessionAffinity,
      keyAlias: provider.keyAlias, preserveAnthropicHeaders: apiProtocol === "anthropic" });
    if (apiProtocol === "openai-chat") {
      const responseFormatAllowed = model.responseFormat === true;
      const supportsTemperature = model.supportsTemperature === true;
      return createOpenAICompatible({
        name: provider.id,
        apiKey: "",
        baseURL: ownerBase,
        includeUsage: true,
        supportsStructuredOutputs: model.structuredOutputs === true,
        convertUsage: convertCompatibleUsage,
        transformRequestBody:
          isOpenRouterApiBase(ownerBase)
            ? openRouterBody(responseFormatAllowed, { supportsTemperature, optionalReasoning: model.optionalReasoning === true, structuredOutput: options.structuredOutput === true, structuredReasoningEffort: model.structuredReasoningEffort, openRouterReasoningEffort: model.openRouterReasoningEffort, freshChatMinimal }, provider.dataCollection ?? "deny")
            : compatibleBody(responseFormatAllowed, supportsTemperature, kiloReasoningOff && isKiloApiBase(ownerBase)),
        fetch: protocolFetch,
      }).languageModel(model.id);
    }
    if (apiProtocol === "openai-responses") {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const inner = createOpenAI({ baseURL: ownerBase, apiKey: "", fetch: protocolFetch, name: provider.id }).responses(model.id);
      return wrapLanguageModel({ model: inner, middleware: responsesStatelessMiddleware(model.supportsReasoning) });
    }
    if (apiProtocol === "anthropic") {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ baseURL: ownerBase, apiKey: "", fetch: protocolFetch, name: provider.id }).languageModel(model.id);
    }
    const { createGoogle } = await import("@ai-sdk/google");
    return createGoogle({ baseURL: ownerBase, apiKey: "", fetch: protocolFetch, name: provider.id }).languageModel(model.id);
  }
  const baseURL = provider.baseUrl.replace(/\/+$/, "");
  const anonymousFetch = anonymous ? createProtocolFetch(env, { rootBase: baseURL, ownerBase: baseURL, anonymous,
    onResponseBytes: options.onResponseBytes, sessionAffinity, preserveAnthropicHeaders: false }) : undefined;
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
    structuredReasoningEffort: model.structuredReasoningEffort,
    openRouterReasoningEffort: model.openRouterReasoningEffort,
    freshChatMinimal,
  };
  return createOpenAICompatible({
    name: provider.id, baseURL, ...(anonymous ? { apiKey: "" } : {}), includeUsage: true,
    supportsStructuredOutputs: structured, convertUsage: convertCompatibleUsage,
    transformRequestBody: isOpenRouterApiBase(baseURL) ? openRouterBody(responseFormatAllowed, transportOptions, provider.dataCollection ?? "deny") : compatibleBody(responseFormatAllowed, supportsTemperature, kiloReasoningOff),
    fetch: anonymousFetch ?? (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== new URL(baseURL + "/chat/completions").href || init?.method !== "POST" || typeof init.body !== "string")
        throw new LibraryError("unavailable", "This provider endpoint is not supported.", 503);
      init.signal?.throwIfAborted();
      const headers = { "Content-Type": "application/json", "x-session-affinity": sessionAffinity,
        "user-agent": "EliotResearch/0.1.0",
        ...(isOpenCodeGoRoot(new URL(baseURL)) ? { "x-opencode-session": sessionAffinity } : {}),
        ...(provider.keyAlias === undefined ? {} : { "cf-aig-byok-alias": provider.keyAlias }),
        "cf-aig-no-wholesale": "true", "cf-aig-max-attempts": "1", "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false" };
      // Native binding mechanism: Agents 0.30.1, packages/agents/src/models/core/transport.ts.
      // Ai.fetch is not declared in the pinned types; preserve its receiver with this narrow cast.
      return (env.AI as unknown as Pick<Fetcher, "fetch">).fetch(
        gatewayUrl,
        { method: "POST", redirect: "manual", body: init.body, headers, ...(init.signal ? { signal: init.signal } : {}) });
    }),
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
const PROVIDER_ERROR_BODY_CHARS = 4096;

function isNoEndpointDataPolicy(error: unknown): boolean {
  const bodies = [
    (error as { responseBody?: unknown } | null | undefined)?.responseBody,
    error instanceof Error ? (error.cause as { responseBody?: unknown } | null | undefined)?.responseBody : undefined,
  ];
  for (const body of bodies) {
    if (typeof body !== "string" || body.length === 0 || body.length > PROVIDER_ERROR_BODY_CHARS) continue;
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

// A structured parameter name is diagnostic only, not a proven rejection cause.
// Inspect immediate direct/cause bodies and at most one provider-wrapper JSON;
// every available body/parameter must agree, without reading message prose.
function badRequestParameter(error: unknown): "reasoning" | "temperature" | "structured-output format" | undefined {
  const cause = error instanceof Error ? error.cause as { responseBody?: unknown; statusCode?: unknown } | null | undefined : undefined;
  const causeStatus = checkStatusCode(cause?.statusCode);
  if (causeStatus !== undefined && causeStatus !== 400) return undefined;
  const bodies = [(error as { responseBody?: unknown } | null | undefined)?.responseBody, cause?.responseBody];
  let identified: ReturnType<typeof badRequestParameter>;
  for (const body of bodies) {
    if (body === undefined) continue;
    if (typeof body !== "string" || body.length === 0 || body.length > PROVIDER_ERROR_BODY_CHARS) return undefined;
    try {
      const failure = (JSON.parse(body) as { error?: { param?: unknown; metadata?: { raw?: unknown } | null } | null } | null)?.error;
      if (!failure || typeof failure !== "object" || Array.isArray(failure)) return undefined;
      const parameters: unknown[] = failure.param === undefined || failure.param === null ? [] : [failure.param];
      const raw = failure.metadata?.raw;
      if (raw !== undefined) {
        if (typeof raw !== "string" || raw.length === 0 || raw.length > PROVIDER_ERROR_BODY_CHARS) return undefined;
        parameters.push((JSON.parse(raw) as { error?: { param?: unknown } | null } | null)?.error?.param);
      }
      if (parameters.length === 0) return undefined;
      for (const param of parameters) {
        const category = param === "reasoning" || param === "reasoning.effort" || param === "reasoning_effort" ? "reasoning"
          : param === "temperature" ? "temperature"
          : param === "response_format" || param === "response_format.json_schema" ? "structured-output format" : undefined;
        if (category === undefined || (identified !== undefined && identified !== category)) return undefined;
        identified = category;
      }
    } catch {
      return undefined;
    }
  }
  return identified;
}

function badRequestCode(error: unknown): number | undefined {
  const cause = error instanceof Error ? error.cause as { responseBody?: unknown } | null | undefined : undefined;
  const bodies = [(error as { responseBody?: unknown } | null | undefined)?.responseBody, cause?.responseBody];
  let identified: number | undefined;
  for (const body of bodies) {
    if (body === undefined) continue;
    if (typeof body !== "string" || body.length === 0 || body.length > PROVIDER_ERROR_BODY_CHARS) return undefined;
    try {
      const errors = (JSON.parse(body) as { errors?: unknown } | null)?.errors;
      if (!Array.isArray(errors) || errors.length === 0) return undefined;
      for (const entry of errors) {
        const code = (entry as { code?: unknown } | null)?.code;
        if (typeof code !== "number" || !Number.isSafeInteger(code) || ![2005, 2044, 7003].includes(code)
          || (identified !== undefined && identified !== code)) return undefined;
        identified = code;
      }
    } catch { return undefined; }
  }
  return identified;
}

export function modelFailure(error: unknown, model: ModelSpec): string {
  const status = errorStatusCode(error);
  const anonymous = model.routing?.provider.authMode === "anonymous";
  if (anonymous && [error, error instanceof Error ? error.cause : undefined].some(value =>
    value instanceof LibraryError && value.message === ANONYMOUS_RESPONSE_LIMIT_REASON)) return ANONYMOUS_RESPONSE_LIMIT_REASON;
  if (model.route.startsWith("gateway:")) {
    if (status === 429) {
      const wait = gatewayRetryAfterSeconds(error);
      const reset = wait === undefined ? "reset unknown" : "retry after " + wait + "s";
      return "External model request failed (HTTP 429). Limit exhausted, " + reset + ". No retry was started.";
    }
    if (status === 404 && isNoEndpointDataPolicy(error)) {
      return NO_ENDPOINT_DATA_POLICY_REASON;
    }
    if (status === 400) {
      const parameter = badRequestParameter(error);
      if (parameter !== undefined) {
        return "External model request failed (HTTP 400). Error response identified the " + parameter + " parameter. Check the selected model's published controls; no retry was started.";
      }
      const code = badRequestCode(error);
      if (code !== undefined) return "External model request failed (HTTP 400). Error response reported code " + code + ". No retry was started.";
    }
    if (status !== undefined) {
      return "External model request failed (HTTP " + status + "). Check the " +
        (anonymous ? "selected provider and its status" : "Gateway connection and provider status") + "; no retry was started.";
    }
    return anonymous ? "External model request failed. Check the selected provider and its status; no retry was started." : EXTERNAL_FAILURE;
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

// Empty-completion diagnostics only. The pinned SDK accepts arbitrary response IDs;
// these prefixes occur in OpenRouter's generation/chat examples, not an exhaustive
// provider contract. Unknown formats (including SDK-generated IDs) stay redacted.
export function safeEmptyCompletionLog(input: {
  turnId: string; model: Pick<ModelSpec, "id" | "route">; finishReason: unknown;
  response: unknown; usage: LanguageModelUsage | undefined;
}) {
  const response = input.response as { id?: unknown; modelId?: unknown; timestamp?: unknown } | null | undefined;
  const id = response?.id, timestamp = response?.timestamp;
  const modelRoute = /^(?:gateway:[a-z0-9][a-z0-9-]{0,63}\/|workers-ai:)[A-Za-z0-9@][A-Za-z0-9@._:/+-]{0,255}$/.test(input.model.route)
    ? input.model.route : null;
  const selectedId = modelRoute?.startsWith("gateway:") ? modelRoute.slice(modelRoute.indexOf("/") + 1) : modelRoute?.slice("workers-ai:".length);
  const timestampMs = timestamp instanceof Date ? Date.prototype.getTime.call(timestamp) : NaN;
  return {
    turnId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.turnId) ? input.turnId : null,
    modelRoute,
    finishReason: typeof input.finishReason === "string" && ["stop", "length", "content-filter", "tool-calls", "error", "other", "interrupted"].includes(input.finishReason)
      ? input.finishReason : null,
    responseAvailable: response !== null && typeof response === "object",
    responseIdPresent: typeof id === "string" && id.length > 0,
    responseId: typeof id === "string" && id.length <= 128 && /^(?:gen|chatcmpl)-[A-Za-z0-9][A-Za-z0-9-]*$/.test(id) ? id : null,
    responseModelId: selectedId === input.model.id && response?.modelId === selectedId ? selectedId : null,
    responseTimestamp: Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : null,
    usagePresent: input.usage !== undefined && input.usage !== null,
    usage: {
      inputTokens: count(input.usage?.inputTokens) ?? null,
      cachedTokens: count(input.usage?.inputTokenDetails?.cacheReadTokens) ?? null,
      outputTokens: count(input.usage?.outputTokens) ?? null,
      reasoningTokens: count(input.usage?.outputTokenDetails?.reasoningTokens) ?? null,
      totalTokens: count(input.usage?.totalTokens) ?? null,
    },
  };
}

// Shared projection for operator logs. Keeps only a validated HTTP status;
// provider messages, bodies, codes and request data stay private. No retry is
// started from this projection; callers surface the stored message as-is.
export function safeErrorLogProjection(error: unknown): { name: string; status?: number } {
  const status = errorStatusCode(error);
  return { name: error instanceof Error ? "Error" : "unknown", ...(status === undefined ? {} : { status }) };
}
