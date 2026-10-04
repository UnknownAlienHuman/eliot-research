import {
  ModelGatewayExecutionError,
  type ModelGatewayExecutionErrorCode,
} from "@eliotr/cloudflare-ai";

const QUALIFICATION_ERROR_CODES = new Set<ModelGatewayExecutionErrorCode>([
  "MODEL_GATEWAY_DEPLOYMENT_MISSING", "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
  "MODEL_GATEWAY_REQUEST_INVALID", "MODEL_GATEWAY_CREDENTIAL_INVALID",
  "MODEL_GATEWAY_TRANSPORT_FAILED", "MODEL_GATEWAY_AUTH_REJECTED",
  "MODEL_GATEWAY_LIMIT_REJECTED", "MODEL_GATEWAY_POLICY_REJECTED",
  "MODEL_GATEWAY_UPSTREAM_REJECTED", "MODEL_GATEWAY_RESPONSE_INVALID",
  "MODEL_GATEWAY_OUTPUT_TRUNCATED", "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
  "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED", "MODEL_GATEWAY_PRICING_FAILED",
]);

export type QualificationResponseInvalidReason =
  | "FINGERPRINT_INVALID"
  | "LOG_READBACK_UNAVAILABLE"
  | "LOG_CORRELATION_INVALID"
  | "LOG_ID_MISSING"
  | "LOG_ID_INVALID"
  | "CONTENT_TYPE_INVALID"
  | "BODY_TOO_LARGE"
  | "BODY_JSON_INVALID"
  | "BODY_SHAPE_INVALID"
  | "MODEL_ID_INVALID"
  | "CACHE_INVALID"
  | "UNCLASSIFIED";

const RESPONSE_SHAPE_INVALID_MESSAGES = new Set([
  "AI Gateway content-length is invalid",
  "AI Gateway response body is missing",
  "AI Gateway response body could not be read",
  "AI Gateway response body is empty",
  "AI Gateway DLP header is not valid JSON",
  "AI Gateway DLP header must be a plain object",
  "AI Gateway DLP action is unsupported",
  "AI Gateway DLP findings are invalid",
  "AI Gateway response contains excessively deep JSON",
  "AI Gateway response contains an oversized JSON string",
  "AI Gateway response contains a non-finite JSON number",
  "AI Gateway response contains a non-JSON value",
  "AI Gateway response contains cyclic JSON",
  "AI Gateway response exceeds the JSON member bound",
  "AI Gateway response contains a non-plain JSON object",
  "AI Gateway response must be a plain object",
  "AI Gateway response usage must be a plain object",
  "AI Gateway response usage.neurons must be an optional finite non-negative number",
  "AI Gateway response usage.prompt_tokens must be a non-negative safe integer",
  "AI Gateway response usage.completion_tokens must be a non-negative safe integer",
  "AI Gateway response usage.total_tokens must be a non-negative safe integer",
  "AI Gateway response token totals do not reconcile",
  "AI Gateway response usage.prompt_tokens_details must be an object",
  "AI Gateway response usage.completion_tokens_details must be an object",
  "AI Gateway response must contain exactly one choice",
  "AI Gateway response choice must be a plain object",
  "AI Gateway response choice index must be zero",
  "AI Gateway response did not finish with stop",
  "AI Gateway response logprobs were not requested",
  "AI Gateway response choice.message must be a plain object",
  "AI Gateway response role must be assistant",
  "AI Gateway response contains unsupported annotations",
  "AI Gateway response id is invalid",
  "AI Gateway response id is not a bounded identifier",
  "AI Gateway response object is not chat.completion",
  "AI Gateway response created must be a non-negative safe integer",
  "AI Gateway response service_tier is invalid",
  "AI Gateway response system_fingerprint is invalid",
  "AI Gateway response reasoning_content is invalid",
  "AI Gateway response assistant content is invalid",
  "AI Gateway response header cf-aig-log-id is invalid",
  "AI Gateway response header cf-aig-cache-status is invalid",
  "AI Gateway response header cf-aig-step is invalid",
  "AI Gateway DLP header is invalid",
]);

export function responseInvalidReason(error: unknown): QualificationResponseInvalidReason | undefined {
  if (!(error instanceof ModelGatewayExecutionError) || error.code !== "MODEL_GATEWAY_RESPONSE_INVALID") {
    return undefined;
  }
  switch (error.message) {
    case "AI Gateway response does not contain a valid dynamic-route fingerprint":
      if (error.cause instanceof Error) {
        if (error.cause.message === "AI Gateway response is missing its response-scoped log id") return "LOG_ID_MISSING";
        if (error.cause.message === "AI Gateway log readback is unavailable") return "LOG_READBACK_UNAVAILABLE";
        if (error.cause.message === "AI Gateway log readback does not match the response" ||
            error.cause.message === "AI Gateway log metadata does not match the request") return "LOG_CORRELATION_INVALID";
      }
      return "FINGERPRINT_INVALID";
    case "AI Gateway response is missing cf-aig-log-id":
      return "LOG_ID_MISSING";
    case "AI Gateway log identifier is invalid":
    case "AI Gateway response header cf-aig-log-id is invalid":
      return "LOG_ID_INVALID";
    case "AI Gateway response must be application/json":
      return "CONTENT_TYPE_INVALID";
    case "AI Gateway response exceeds its byte budget":
      return "BODY_TOO_LARGE";
    case "AI Gateway response is not valid UTF-8 JSON":
      return "BODY_JSON_INVALID";
    case "AI Gateway response model is invalid":
    case "AI Gateway response model is not a bounded model identifier":
      return "MODEL_ID_INVALID";
    case "AI Gateway cache status is unsupported":
    case "AI Gateway returned a cache hit despite explicit cache bypass":
      return "CACHE_INVALID";
    default:
      return RESPONSE_SHAPE_INVALID_MESSAGES.has(error.message)
        ? "BODY_SHAPE_INVALID"
        : "UNCLASSIFIED";
  }
}

export type QualificationTransportReason =
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "REDIRECTED"
  | "BODY_TOO_LARGE"
  | "BODY_READ_FAILED"
  | "NETWORK_CONNECTION_LOST"
  | "FETCH_TYPE_ERROR"
  | "FETCH_ERROR"
  | "ILLEGAL_INVOCATION"
  | "FETCH_NOT_SUPPORTED"
  | "UNCLASSIFIED";

const ILLEGAL_INVOCATION_MESSAGES = new Set([
  "Illegal invocation",
  "Illegal invocation: function called with incorrect `this` reference. See https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors for details.",
]);

export function transportFailureReason(error: unknown): QualificationTransportReason | undefined {
  if (!(error instanceof ModelGatewayExecutionError) || error.code !== "MODEL_GATEWAY_TRANSPORT_FAILED") {
    return undefined;
  }
  const cause = error.cause;
  if (!(cause instanceof Error)) return "UNCLASSIFIED";
  if (cause.name === "AbortError") {
    switch (cause.message) {
      case "model gateway call was cancelled":
      case "model gateway response consumption was cancelled":
        return "CANCELLED";
      case "model gateway response deadline exceeded":
        return "DEADLINE_EXCEEDED";
      case "model gateway response was redirected":
        return "REDIRECTED";
      case "model gateway response exceeds its bounded byte budget":
        return "BODY_TOO_LARGE";
      case "model gateway response body cannot be read":
      case "model gateway response body could not be read":
        return "BODY_READ_FAILED";
      default:
        break;
    }
  }
  if (cause.name === "TypeError" && cause.message === 'Invalid redirect value, must be one of "follow" or "manual" ("error" won\'t be implemented since it does not make sense at the edge; use "manual" and check the response status code).') return "FETCH_NOT_SUPPORTED";
  if (cause.name === "TypeError" && ILLEGAL_INVOCATION_MESSAGES.has(cause.message)) return "ILLEGAL_INVOCATION";
  if (cause.name === "Error" && (cause.message === "Network connection lost." || cause.message === "Network connection lost")) return "NETWORK_CONNECTION_LOST";
  if (cause.name === "TypeError") return "FETCH_TYPE_ERROR";
  if (cause.name === "Error") return "FETCH_ERROR";
  return "UNCLASSIFIED";
}

export function qualificationFailureTitle(
  status: number | undefined,
  providerCodes: readonly number[],
  reason: QualificationResponseInvalidReason | undefined,
  transportReason: QualificationTransportReason | undefined,
): string {
  const details: string[] = [];
  if (status !== undefined) details.push(`upstream HTTP ${status}`);
  if (providerCodes.length > 0) details.push(`provider codes ${providerCodes.join(",")}`);
  if (transportReason !== undefined) details.push(`transport reason ${transportReason}`);
  if (reason !== undefined) details.push(`response reason ${reason}`);
  return details.length === 0
    ? "Document model qualification could not complete"
    : `Document model qualification could not complete (${details.join("; ")})`;
}

export function typedUpstreamStatus(error: unknown): number | undefined {
  if (!(error instanceof ModelGatewayExecutionError)) return undefined;
  const status = error.http_status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

export function isQualificationExecutionError(error: unknown): error is ModelGatewayExecutionError {
  return error instanceof ModelGatewayExecutionError && QUALIFICATION_ERROR_CODES.has(error.code);
}
