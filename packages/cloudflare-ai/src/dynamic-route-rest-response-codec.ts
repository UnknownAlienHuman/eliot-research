import {
  readResponseBodyWithinBytes,
  RuntimeLimitError,
} from "@eliotr/platform-cloudflare";
import { canonicalModelGatewayJson } from "./model-gateway-request.js";
import {
  DYNAMIC_ROUTE_REST_RESPONSE_MAX_BYTES,
  type DynamicRouteRestAmbiguousEffect,
  type DynamicRouteRestResponse,
} from "./dynamic-route-rest-contract.js";
import {
  boundedStatus,
  dynamicRouteRestFailure,
  exactObject,
  responseInvalid,
} from "./dynamic-route-rest-codec.js";

const MAX_API_MESSAGES = 100;
const MAX_API_MESSAGE_BYTES = 4 * 1024;
const ENVELOPE_KEYS = new Set([
  "data",
  "errors",
  "messages",
  "result",
  "result_info",
  "success",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function readDynamicRouteRestJson(
  response: DynamicRouteRestResponse,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect,
): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    // A null native Response body is empty, matching the former text() fallback.
    bytes = await readResponseBodyWithinBytes(response, {
      label: "cloudflare.dynamic-route.response",
      max_bytes: DYNAMIC_ROUTE_REST_RESPONSE_MAX_BYTES,
    });
  } catch (error) {
    if (error instanceof RuntimeLimitError) {
      switch (error.code) {
        case "LIMIT_EXCEEDED":
        case "STREAM_CHUNK_LIMIT_EXCEEDED":
          return dynamicRouteRestFailure(
            "DYNAMIC_ROUTE_REST_RESPONSE_TOO_LARGE",
            "Cloudflare response exceeds the byte envelope",
            { ambiguous_effect: ambiguousEffect },
          );
        case "INVALID_CONTENT_LENGTH":
          return dynamicRouteRestFailure(
            "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
            "Cloudflare response contains a malformed content-length",
            { ambiguous_effect: ambiguousEffect },
          );
        case "STREAM_CHUNK_INVALID":
          return dynamicRouteRestFailure(
            "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
            "Cloudflare response stream returned a non-byte chunk",
            { ambiguous_effect: ambiguousEffect },
          );
      }
    }
    throw error;
  }

  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
      "Cloudflare response is not valid UTF-8",
      { ambiguous_effect: ambiguousEffect },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
      "Cloudflare response is not valid JSON",
      { ambiguous_effect: ambiguousEffect },
    );
  }
}

export function decodeCloudflareApiEnvelope(
  raw: unknown,
  response: DynamicRouteRestResponse,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect,
): Readonly<{ result: unknown; result_info: unknown }> {
  const root = exactObject(
    raw,
    ENVELOPE_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare API envelope",
    ambiguousEffect,
  );
  if (typeof root.success !== "boolean") {
    responseInvalid("Cloudflare API success flag is malformed", ambiguousEffect);
  }
  decodeMessageArray(root.errors, "errors", ambiguousEffect);
  decodeMessageArray(root.messages, "messages", ambiguousEffect);
  if (!response.ok) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_HTTP_FAILED",
      `Cloudflare control plane returned HTTP ${boundedStatus(response.status)}`,
      {
        retryable: response.status >= 500,
        ambiguous_effect: ambiguousEffect,
      },
    );
  }
  if (
    root.success !== true ||
    (Array.isArray(root.errors) && root.errors.length !== 0)
  ) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_API_FAILED",
      "Cloudflare control plane rejected the request",
      { ambiguous_effect: ambiguousEffect },
    );
  }
  const hasResult = "result" in root;
  const hasData = "data" in root;
  if (hasResult === hasData) {
    responseInvalid(
      "Cloudflare API envelope must contain exactly one result or data payload",
      ambiguousEffect,
    );
  }
  if (hasData && "result_info" in root) {
    responseInvalid(
      "Cloudflare data envelope cannot contain result_info",
      ambiguousEffect,
    );
  }
  if (!hasResult && !hasData) {
    responseInvalid("Cloudflare API result is missing", ambiguousEffect);
  }
  return Object.freeze({
    result: hasResult ? root.result : root.data,
    result_info: root.result_info,
  });
}

function decodeMessageArray(
  raw: unknown,
  label: string,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect,
): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.length > MAX_API_MESSAGES) {
    responseInvalid(`Cloudflare API ${label} is malformed`, ambiguousEffect);
  }
  for (const entry of raw) {
    const json = canonicalModelGatewayJson(entry);
    if (encoder.encode(json).byteLength > MAX_API_MESSAGE_BYTES) {
      responseInvalid(
        `Cloudflare API ${label} exceeds its bound`,
        ambiguousEffect,
      );
    }
  }
}
