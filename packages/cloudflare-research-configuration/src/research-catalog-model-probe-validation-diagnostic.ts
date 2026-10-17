import { ModelGatewayExecutionError } from "@eliotr/cloudflare-ai";

// Exact developer-authored messages only. Never truncate/copy an arbitrary error:
// decoder messages about unsupported fields can contain provider-controlled keys.
const SAFE_MESSAGES = new Set([
  "OpenAI Responses result is not a completed successful response",
  "OpenAI Responses output is invalid",
  "OpenAI Responses contains an unsupported output item",
  "OpenAI Responses contains unsupported assistant content",
  "OpenAI Responses must contain one text message",
  "OpenAI Responses token totals do not reconcile",
  "OpenAI Responses store flag is invalid",
  "OpenAI Responses message is not a final answer",
  "OpenAI Responses contains unrequested logprobs",
  "chat response must contain exactly one choice",
  "chat response choice index must be zero",
  "chat response did not finish with stop",
  "chat response contains unrequested logprobs",
  "chat response role is not assistant",
  "chat response contains unsupported annotations",
  "chat reasoning content is invalid",
  "chat response token totals do not reconcile",
  "chat response neurons are invalid",
  "chat response usage details must be objects",
  "Anthropic response is not an assistant message",
  "Anthropic response did not complete as a text answer",
  "Anthropic response content is invalid",
  "Anthropic response contains unsupported assistant content",
  "Anthropic response reports unrequested cached input usage",
  "Anthropic response reports unrequested cache creation usage",
  "Anthropic response reports unrequested server-tool usage",
  "provider response format is unsupported",
  "provider response must be a plain object",
  "provider response is not valid UTF-8 JSON",
  "provider response JSON is excessively deep",
  "provider response JSON contains a non-finite number",
  "provider response JSON exceeds the member bound",
  "provider response contains a non-JSON value",
  "provider response must be application/json",
  "provider response body is missing",
  "provider response body is empty",
  "provider response exceeds its byte budget",
  "provider response body could not be read",
  "provider content-length is invalid",
  "provider response model differs from the selected exact model",
]);

const SAFE_OBJECT_LABELS = [
  "OpenAI Responses", "OpenAI Responses usage", "chat response", "chat response choice",
  "chat response message", "chat response usage", "Anthropic response", "Anthropic response usage",
  "Anthropic cache creation usage", "Anthropic server tool usage",
] as const;
for (const label of SAFE_OBJECT_LABELS) SAFE_MESSAGES.add(`${label} must be a plain object`);

const SAFE_VALUE_LABELS = [
  "OpenAI Responses id", "OpenAI Responses model", "chat response id", "chat response model",
  "Anthropic response id", "Anthropic response model",
] as const;
for (const label of SAFE_VALUE_LABELS) SAFE_MESSAGES.add(`${label} is not a bounded identifier`);
for (const label of [
  "OpenAI Responses created_at", "OpenAI Responses refusal", "OpenAI Responses output text",
  "OpenAI Responses input tokens", "OpenAI Responses output tokens", "OpenAI Responses total tokens",
  "chat response created", "chat response service_tier", "chat response system_fingerprint",
  "chat response assistant content", "chat input tokens", "chat output tokens", "chat total tokens",
  "Anthropic response text", "Anthropic thinking block", "Anthropic thinking signature",
  "Anthropic redacted thinking block", "Anthropic input tokens", "Anthropic output tokens",
]) SAFE_MESSAGES.add(`${label} is invalid`);

/** At most 192 ASCII bytes; no provider value, cause, stack, prompt or body is returned. */
export function catalogModelProbeValidationMessage(cause: unknown): string {
  if (!(cause instanceof ModelGatewayExecutionError) || cause.code !== "MODEL_GATEWAY_RESPONSE_INVALID" ||
      cause.message.length > 4096) return "UNCLASSIFIED";
  if (SAFE_MESSAGES.has(cause.message)) return cause.message;
  for (const label of SAFE_OBJECT_LABELS) {
    if (cause.message.startsWith(`${label} contains unsupported field `)) {
      return `${label} contains an unsupported field (name withheld)`;
    }
  }
  for (const [pattern, label] of [
    [/^OpenAI Responses output\[[0-9]{1,4}\] /u, "OpenAI Responses output item"],
    [/^OpenAI Responses content\[[0-9]{1,4}\] /u, "OpenAI Responses content item"],
    [/^Anthropic content\[[0-9]{1,4}\] /u, "Anthropic content item"],
  ] as const) {
    const suffix = cause.message.replace(pattern, "");
    if (suffix === cause.message) continue;
    if (suffix === "must be a plain object") return `${label} must be a plain object`;
    if (suffix.startsWith("contains unsupported field ")) return `${label} contains an unsupported field (name withheld)`;
  }
  return "UNCLASSIFIED";
}
