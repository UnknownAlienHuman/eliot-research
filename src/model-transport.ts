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

export interface AssistantWire {
  content: string;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: JSONObject[];
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
function openRouterBody(responseFormatAllowed: boolean, reasoning?: ModelSpec["reasoning"]) {
  return (args: Record<string, unknown>): Record<string, unknown> => {
    const provider = { ...(args.provider as Record<string, unknown> | undefined), allow_fallbacks: false, require_parameters: true };
    const out: Record<string, unknown> = { ...args, provider, ...(reasoning ? { reasoning } : {}) };
    if (!responseFormatAllowed) delete out.response_format;
    return out;
  };
}

const MAX_ASSISTANT_JSON_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Consumes the pinned AI SDK's raw JSON chunks. The SDK owns SSE framing and
// decoding; the caller persists message() only after a successful SDK stream.
export class AssistantWireCapture {
  private byteCount = 0;
  private valid = true;
  private sawFinish = false;
  private content = "";
  private reasoningContent = "";
  private reasoning = "";
  private readonly reasoningDetails: JSONObject[] = [];
  private readonly detailsById = new Map<string, JSONObject>();
  private readonly detailsByIndex = new Map<number, JSONObject>();

  push(rawValue: unknown): void {
    if (!this.valid) return;
    if (!isRecord(rawValue)) { this.invalidate(); return; }
    let bytes: number;
    try {
      const json = JSON.stringify(rawValue);
      if (json === undefined) { this.invalidate(); return; }
      bytes = new TextEncoder().encode(json).byteLength;
    } catch { this.invalidate(); return; }
    if (bytes > MAX_ASSISTANT_JSON_BYTES - this.byteCount) { this.invalidate(); return; }
    this.byteCount += bytes;
    if ("error" in rawValue && rawValue.error !== null && rawValue.error !== undefined) {
      this.invalidate(); return;
    }
    if (!Array.isArray(rawValue.choices)) {
      if (!isRecord(rawValue.usage)) this.invalidate();
      return;
    }
    if (rawValue.choices.length === 0) return;
    if (rawValue.choices.length !== 1 || !isRecord(rawValue.choices[0])) { this.invalidate(); return; }
    const choice = rawValue.choices[0];
    if (choice.finish_reason === "error" || (choice.error !== undefined && choice.error !== null)
      || (choice.index !== undefined && choice.index !== 0)) { this.invalidate(); return; }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== "string" || choice.finish_reason.length === 0) { this.invalidate(); return; }
      this.sawFinish = true;
    }
    if (choice.delta === undefined || choice.delta === null) return;
    if (!isRecord(choice.delta)) { this.invalidate(); return; }
    const delta = choice.delta;
    if (delta.role !== undefined && delta.role !== "assistant") { this.invalidate(); return; }
    if (!this.appendDelta(delta, "content", "content")
      || !this.appendDelta(delta, "reasoning_content", "reasoningContent")
      || !this.appendDelta(delta, "reasoning", "reasoning")) return;
    if (delta.reasoning_details === undefined || delta.reasoning_details === null) return;
    if (!Array.isArray(delta.reasoning_details)) { this.invalidate(); return; }
    for (const detail of delta.reasoning_details) {
      if (!isRecord(detail) || !this.appendReasoningDetail(detail)) { this.invalidate(); return; }
    }
  }

  message(): AssistantWire | undefined {
    if (!this.valid || !this.sawFinish || !this.content.trim()) return undefined;
    return { content: this.content,
      ...(this.reasoningContent.length ? { reasoning_content: this.reasoningContent } : {}),
      ...(this.reasoning.length ? { reasoning: this.reasoning } : {}),
      ...(this.reasoningDetails.length ? { reasoning_details: this.reasoningDetails.map((detail) => ({ ...detail })) } : {}) };
  }

  private appendDelta(delta: Record<string, unknown>, field: string, target: "content" | "reasoningContent" | "reasoning"): boolean {
    const value = delta[field];
    if (value === undefined || value === null) return true;
    if (typeof value !== "string") {
      this.invalidate();
      return false;
    }
    if (target === "content") this.content += value;
    else if (target === "reasoningContent") this.reasoningContent += value;
    else this.reasoning += value;
    return true;
  }

  private appendReasoningDetail(input: Record<string, unknown>): boolean {
    const hasId = input.id !== undefined;
    const hasIndex = input.index !== undefined;
    if ((hasId && typeof input.id !== "string")
      || (hasIndex && (typeof input.index !== "number" || !Number.isSafeInteger(input.index) || input.index < 0))) return false;
    const id = typeof input.id === "string" && input.id.length > 0 ? input.id : undefined;
    const index = typeof input.index === "number" ? input.index : undefined;
    if (id === undefined && index === undefined) return false;
    const byId = id === undefined ? undefined : this.detailsById.get(id);
    const byIndex = index === undefined ? undefined : this.detailsByIndex.get(index);
    if (byId && byIndex && byId !== byIndex) return false;
    let target = byId ?? byIndex;
    if (!target) {
      target = Object.create(null) as JSONObject;
      this.reasoningDetails.push(target);
    }
    if (id !== undefined) {
      const conflict = this.detailsById.get(id);
      if (conflict && conflict !== target) return false;
      this.detailsById.set(id, target);
    }
    if (index !== undefined) {
      const conflict = this.detailsByIndex.get(index);
      if (conflict && conflict !== target) return false;
      this.detailsByIndex.set(index, target);
    }

    const record = target as Record<string, unknown>;
    for (const [field, value] of Object.entries(input)) {
      const previous = record[field];
      if (field === "id" || field === "index" || field === "type" || field === "format") {
        if (previous !== undefined && previous !== value) return false;
        record[field] = value;
      } else if (typeof value === "string") {
        if (previous === undefined) record[field] = value;
        else if (field === "text" || field === "summary") {
          if (typeof previous !== "string") return false;
          if (value.startsWith(previous)) record[field] = value;
          // A non-extending piece is incremental, even when it is a shorter
          // prefix of the previous snapshot (OpenCodex response-events.ts).
          else record[field] = previous + value;
        } else if (previous !== value) return false;
      } else {
        if (previous === undefined) record[field] = value;
        else if (JSON.stringify(previous) !== JSON.stringify(value)) return false;
      }
    }
    return true;
  }

  private invalidate() {
    this.valid = false;
    this.content = "";
    this.reasoningContent = "";
    this.reasoning = "";
    this.reasoningDetails.length = 0;
    this.detailsById.clear();
    this.detailsByIndex.clear();
  }
}

export async function resolveModelTransport(
  env: Pick<Env, "AI" | "DB">,
  model: ModelSpec,
  sessionAffinity: string,
  assistantHistory?: AssistantWire[],
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
          const messages = Array.isArray(out.messages) ? out.messages : null;
          if (assistantHistory) {
            const count = messages?.filter((entry) => isRecord(entry) && entry.role === "assistant").length ?? 0;
            if (count !== assistantHistory.length) {
              throw new LibraryError("conflict",
                "This history has no complete original protocol state for the selected model. Start a new chat; no model call was made.", 409);
            }
            if (messages) {
              let index = 0;
              out.messages = messages.map((entry) => {
                if (!isRecord(entry) || entry.role !== "assistant") return entry;
                const base = { ...entry };
                delete base.reasoning_content;
                delete base.reasoning;
                delete base.reasoning_details;
                return { ...base, ...assistantHistory[index++] };
              });
            }
          }
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
    const responseFormatAllowed = model.responseFormat === true;
    const openrouter = createOpenAICompatible<string, string, string, string>({
      name: "openrouter",
      baseURL: OPENROUTER_BASE_URL,
      includeUsage: true,
      supportsStructuredOutputs: structured,
      transformRequestBody: openRouterBody(responseFormatAllowed, model.reasoning),
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
